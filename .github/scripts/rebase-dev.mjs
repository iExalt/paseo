import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const RESOLUTION_REF = "refs/heads/rebase-resolutions";
const DEV_REF = "refs/heads/dev";
const UPSTREAM_REF = "refs/heads/upstream/main";
const CACHE_PREFIX = "resolutions/";
const SCHEMA_PATH = "schema.json";
const SCHEMA_TEXT = '{"version":1,"format":"git-rerere-cache-v1"}\n';
const SIGNING_EMAIL = "clliaw@nvidia.com";
const SIGNING_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEScQeKzAdwWjNsrJ7xQNq2BAKGSkXP6FPbBD7PZrM9J";

async function git(repositoryPath, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", ...options.env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code === "ENOENT" ? 127 : (error.code ?? 1),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

async function gitChecked(repositoryPath, args, options) {
  const result = await git(repositoryPath, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function gitObject(repositoryPath, type, oid) {
  try {
    const result = await execFileAsync("git", ["cat-file", type, oid], {
      cwd: repositoryPath,
      encoding: "buffer",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : error.stderr;
    throw new Error(`git cat-file ${type} ${oid} failed: ${(stderr ?? error.message).trim()}`);
  }
}

async function gitBlob(repositoryPath, oid) {
  return gitObject(repositoryPath, "blob", oid);
}

function parseLsRemote(text) {
  const refs = new Map();
  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split("\t");
    if (!/^[0-9a-f]{40}$/.test(sha) || refs.has(ref)) {
      throw new Error(`Invalid or duplicate ls-remote row: ${line}`);
    }
    refs.set(ref, sha);
  }
  return refs;
}

async function snapshotRefs(repositoryPath, remote) {
  const remoteText = await gitChecked(repositoryPath, [
    "ls-remote",
    "--refs",
    remote,
    DEV_REF,
    UPSTREAM_REF,
    RESOLUTION_REF,
  ]);
  const refs = parseLsRemote(remoteText);
  const snapshots = {
    dev: refs.get(DEV_REF),
    upstream: refs.get(UPSTREAM_REF),
    resolutions: refs.get(RESOLUTION_REF),
  };
  for (const [name, sha] of Object.entries(snapshots)) {
    if (!sha) throw new Error(`Required ${name} ref is missing on ${remote}`);
  }

  await gitChecked(repositoryPath, [
    "fetch",
    "--no-tags",
    remote,
    `+${DEV_REF}:refs/codex/snapshot/dev`,
    `+${UPSTREAM_REF}:refs/codex/snapshot/upstream`,
    `+${RESOLUTION_REF}:refs/codex/snapshot/resolutions`,
  ]);
  const fetched = {
    dev: await gitChecked(repositoryPath, ["rev-parse", "refs/codex/snapshot/dev"]),
    upstream: await gitChecked(repositoryPath, ["rev-parse", "refs/codex/snapshot/upstream"]),
    resolutions: await gitChecked(repositoryPath, ["rev-parse", "refs/codex/snapshot/resolutions"]),
  };
  for (const name of Object.keys(snapshots)) {
    if (fetched[name].trim() !== snapshots[name]) {
      throw new Error(`${name} ref moved while snapshots were fetched; rerun from current refs`);
    }
  }
  return snapshots;
}

function parseTree(text) {
  const entries = [];
  for (const row of text.split("\0")) {
    if (!row) continue;
    const match = /^(\d{6}) (blob) ([0-9a-f]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error(`Unexpected resolution tree entry: ${JSON.stringify(row)}`);
    entries.push({ mode: match[1], oid: match[3], path: match[4] });
  }
  return entries;
}

export async function importResolutions(repositoryPath, resolutionSha) {
  if (!/^[0-9a-f]{40}$/.test(resolutionSha ?? "")) {
    throw new Error("A captured resolution-branch SHA is required");
  }
  const tree = await gitChecked(repositoryPath, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    resolutionSha,
  ]);
  const entries = parseTree(tree);
  const schema = entries.find((entry) => entry.path === SCHEMA_PATH);
  if (entries.length === 0 || !schema || schema.mode !== "100644") {
    throw new Error("Resolution branch must contain the regular schema.json file");
  }
  if ((await gitChecked(repositoryPath, ["cat-file", "blob", schema.oid])) !== SCHEMA_TEXT) {
    throw new Error(`Unsupported resolution schema in ${SCHEMA_PATH}`);
  }

  const pairs = new Map();
  for (const entry of entries) {
    if (entry.path === SCHEMA_PATH) continue;
    const match = /^resolutions\/([0-9a-f]{40})\/(preimage|postimage)(\.\d+)?$/.exec(entry.path);
    if (!match || entry.mode !== "100644") {
      throw new Error(`Unsupported path or file mode in resolution branch: ${entry.path}`);
    }
    const [, id, side, suffix = ""] = match;
    const key = `${id}/${suffix}`;
    const pair = pairs.get(key) ?? { id, suffix, sides: new Set() };
    if (pair.sides.has(side)) throw new Error(`Duplicate ${side} for ${key}`);
    pair.sides.add(side);
    pairs.set(key, pair);
  }
  for (const [key, pair] of pairs) {
    if (pair.sides.size !== 2) throw new Error(`Incomplete resolution pair: ${key}`);
  }

  const cacheRoot = await gitChecked(repositoryPath, ["rev-parse", "--git-path", "rr-cache"]);
  const resolvedCacheRoot = cacheRoot.trim().startsWith("/")
    ? cacheRoot.trim()
    : join(repositoryPath, cacheRoot.trim());
  await mkdir(resolvedCacheRoot, { recursive: true });
  for (const entry of entries) {
    if (entry.path === SCHEMA_PATH) continue;
    const relative = entry.path.slice(CACHE_PREFIX.length);
    const destination = join(resolvedCacheRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    const content = await gitBlob(repositoryPath, entry.oid);
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  }
  return pairs.size;
}

async function unmergedPaths(repositoryPath) {
  const result = await gitChecked(repositoryPath, ["ls-files", "-u", "-z"]);
  return result ? result.split("\0").filter(Boolean) : [];
}

async function stagedPaths(repositoryPath) {
  const result = await gitChecked(repositoryPath, ["diff", "--cached", "--name-only", "-z"]);
  return result ? result.split("\0").filter(Boolean) : [];
}

async function rebaseProgress(repositoryPath) {
  const head = (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim();
  const current = await git(repositoryPath, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]);
  const staged = (await gitChecked(repositoryPath, ["diff", "--cached", "--raw"])).trim();
  const unmerged = (await gitChecked(repositoryPath, ["ls-files", "-u"])).trim();
  return `${head}:${current.code === 0 ? current.stdout.trim() : "none"}:${staged}:${unmerged}`;
}

function isReusableRerereStop(result, paths, indexPaths) {
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  const reusedRecords = diagnostics.match(/^Staged '.+' using previous resolution\.$/gm) ?? [];
  return (
    result.code !== 0 &&
    /CONFLICT \(/.test(diagnostics) &&
    /could not apply [0-9a-f]+/.test(diagnostics) &&
    reusedRecords.length > 0 &&
    paths.length === 0 &&
    indexPaths.length > 0
  );
}

async function continueKnownResolutions(repositoryPath, firstResult, maxContinuations) {
  let result = firstResult;
  for (let attempt = 0; attempt < maxContinuations; attempt += 1) {
    const conflicts = await unmergedPaths(repositoryPath);
    const staged = await stagedPaths(repositoryPath);
    const state = await git(repositoryPath, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]);
    const gitDir = (
      await gitChecked(repositoryPath, ["rev-parse", "--git-path", "rebase-merge"])
    ).trim();
    const rebaseDirectory = join(repositoryPath, gitDir);
    const directoryExists = await import("node:fs/promises").then(({ access }) =>
      access(rebaseDirectory).then(
        () => true,
        () => false,
      ),
    );
    if (state.code !== 0 || !directoryExists || !isReusableRerereStop(result, conflicts, staged)) {
      throw new Error(
        `Rebase stopped without a safely reusable completed resolution:\n${result.stdout}\n${result.stderr}`,
      );
    }
    const before = await rebaseProgress(repositoryPath);
    result = await git(repositoryPath, [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=true",
      "-c",
      "user.name=Rebase staging",
      "-c",
      "user.email=rebase-staging@users.noreply.github.com",
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
    if (result.code === 0) return;
    const after = await rebaseProgress(repositoryPath);
    if (before === after) throw new Error("Rebase continuation made no progress; stopping safely");
  }
  throw new Error(
    `Rebase exceeded the captured replay bound of ${maxContinuations} automatic continuations`,
  );
}

async function replayCommitCount(repositoryPath, upstreamSha, devSha) {
  const output = (
    await gitChecked(repositoryPath, ["rev-list", "--count", `${upstreamSha}..${devSha}`])
  ).trim();
  if (!/^(0|[1-9]\d*)$/.test(output)) {
    throw new Error(`Git returned an invalid replay commit count: ${JSON.stringify(output)}`);
  }
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Git returned an unsafe replay commit count: ${output}`);
  }
  return count;
}

async function replayCommitIds(repositoryPath, upstreamSha, devSha) {
  const range = `${upstreamSha}..${devSha}`;
  const merges = (await gitChecked(repositoryPath, ["rev-list", "--merges", range])).trim();
  if (merges)
    throw new Error("Rebase signing supports linear dev history only; merge commits found");
  const output = await gitChecked(repositoryPath, ["rev-list", "--reverse", range]);
  return output.trim() ? output.trim().split("\n") : [];
}

function parseCommitObject(raw, sha) {
  const separator = raw.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new Error(`Commit ${sha} has no header/message separator`);
  const headerBytes = raw.subarray(0, separator);
  let headerText;
  try {
    headerText = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
  } catch {
    throw new Error(`Commit ${sha} has unsupported non-UTF-8 metadata`);
  }
  const headers = new Map();
  let previous = "";
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) {
      if (previous !== "gpgsig")
        throw new Error(`Commit ${sha} has an unsupported continued header`);
      continue;
    }
    const separatorIndex = line.indexOf(" ");
    if (separatorIndex < 1) throw new Error(`Commit ${sha} has an invalid header`);
    const name = line.slice(0, separatorIndex);
    if (!["tree", "parent", "author", "committer", "encoding", "gpgsig"].includes(name)) {
      throw new Error(`Commit ${sha} has an unsupported ${name} header`);
    }
    const value = line.slice(separatorIndex + 1);
    const values = headers.get(name) ?? [];
    values.push(value);
    headers.set(name, values);
    previous = name;
  }
  const one = (name, required = true) => {
    const values = headers.get(name) ?? [];
    if (values.length > 1 || (required && values.length !== 1)) {
      throw new Error(`Commit ${sha} has an unsupported ${name} header count`);
    }
    return values[0];
  };
  const parents = headers.get("parent") ?? [];
  if (parents.length !== 1) throw new Error(`Commit ${sha} is not a single-parent replay commit`);
  const encoding = one("encoding", false);
  if (encoding && !/^[A-Za-z0-9._-]+$/.test(encoding)) {
    throw new Error(`Commit ${sha} has an unsupported encoding header`);
  }
  const author = one("author");
  const committer = one("committer");
  const parseIdentity = (field, value) => {
    const match = /^(.*) <([^>]*)> (-?\d+ [+-]\d{4})$/.exec(value);
    if (!match) throw new Error(`Commit ${sha} has an unsupported ${field} identity`);
    return { line: `${field} ${value}`, name: match[1], email: match[2], date: match[3] };
  };
  return {
    author: parseIdentity("author", author),
    committer: parseIdentity("committer", committer),
    encoding,
    message: raw.subarray(separator + 2),
  };
}

async function validateSigningKey(signingKey, publicKey) {
  if (!signingKey) throw new Error("PASEO_REBASE_SSH_SIGNING_KEY is required");
  const trustedPublicKey = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(trustedPublicKey)) {
    throw new Error("Configured rebase SSH public key is invalid");
  }
  const temporaryDirectory = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "paseo-rebase-key-check-"),
  );
  const privateKeyPath = join(temporaryDirectory, "signing-key");
  try {
    await writeFile(privateKeyPath, signingKey, { flag: "wx", mode: 0o600 });
    await chmod(privateKeyPath, 0o600);
    let derivedKey;
    try {
      derivedKey = await execFileAsync("ssh-keygen", ["-y", "-f", privateKeyPath], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error("PASEO_REBASE_SSH_SIGNING_KEY is not a readable SSH private key");
    }
    const derivedPublicKey = derivedKey.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
    if (derivedPublicKey !== trustedPublicKey) {
      throw new Error("PASEO_REBASE_SSH_SIGNING_KEY does not match the trusted public key");
    }
    return trustedPublicKey;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function signRebasedCommits(
  repositoryPath,
  upstreamSha,
  originalCommits,
  signingKey,
  publicKey,
) {
  if (!signingKey) throw new Error("PASEO_REBASE_SSH_SIGNING_KEY is required");
  const trustedPublicKey = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(trustedPublicKey)) {
    throw new Error("Configured rebase SSH public key is invalid");
  }

  const rebasedHead = (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim();
  const rebasedCommits = await replayCommitIds(repositoryPath, upstreamSha, rebasedHead);
  if (originalCommits.length !== rebasedCommits.length) {
    throw new Error(
      `Replayed commit count changed (${originalCommits.length} original, ${rebasedCommits.length} rewritten)`,
    );
  }
  const originals = [];
  const rebased = [];
  for (let index = 0; index < originalCommits.length; index += 1) {
    const original = parseCommitObject(
      await gitObject(repositoryPath, "commit", originalCommits[index]),
      originalCommits[index],
    );
    const rewritten = parseCommitObject(
      await gitObject(repositoryPath, "commit", rebasedCommits[index]),
      rebasedCommits[index],
    );
    if (
      original.author.line !== rewritten.author.line ||
      !original.message.equals(rewritten.message)
    ) {
      throw new Error(
        `Rebase changed the author or message while mapping ${originalCommits[index]}`,
      );
    }
    if (original.committer.email !== SIGNING_EMAIL) {
      throw new Error(
        `Cannot sign replay from unrecognized committer email ${original.committer.email}`,
      );
    }
    originals.push(original);
    rebased.push(rebasedCommits[index]);
  }

  const temporaryDirectory = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "paseo-rebase-sign-"),
  );
  const privateKeyPath = join(temporaryDirectory, "signing-key");
  const allowedSignersPath = join(temporaryDirectory, "allowed-signers");
  const messagePath = join(temporaryDirectory, "commit-message");
  try {
    await writeFile(privateKeyPath, signingKey, { flag: "wx", mode: 0o600 });
    await chmod(privateKeyPath, 0o600);
    let derivedKey;
    try {
      derivedKey = await execFileAsync("ssh-keygen", ["-y", "-f", privateKeyPath], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error("PASEO_REBASE_SSH_SIGNING_KEY is not a readable SSH private key");
    }
    const derivedPublicKey = derivedKey.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
    if (derivedPublicKey !== trustedPublicKey) {
      throw new Error("PASEO_REBASE_SSH_SIGNING_KEY does not match the trusted public key");
    }
    await writeFile(allowedSignersPath, `${SIGNING_EMAIL} ${trustedPublicKey}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    let parent = upstreamSha;
    for (let index = 0; index < originals.length; index += 1) {
      const original = originals[index];
      const tree = (
        await gitChecked(repositoryPath, ["rev-parse", `${rebased[index]}^{tree}`])
      ).trim();
      await writeFile(messagePath, original.message, { mode: 0o600 });
      const args = ["-c", "gpg.format=ssh", "-c", `user.signingkey=${privateKeyPath}`];
      if (original.encoding) args.push("-c", `i18n.commitEncoding=${original.encoding}`);
      args.push("commit-tree", "-S", tree, "-p", parent, "-F", messagePath);
      const commitEnvironment = {
        ...process.env,
        LC_ALL: "C",
        GIT_AUTHOR_NAME: original.author.name,
        GIT_AUTHOR_EMAIL: original.author.email,
        GIT_AUTHOR_DATE: original.author.date,
        GIT_COMMITTER_NAME: original.committer.name,
        GIT_COMMITTER_EMAIL: original.committer.email,
        GIT_COMMITTER_DATE: original.committer.date,
      };
      const signedSha = (await gitChecked(repositoryPath, args, { env: commitEnvironment })).trim();
      const signed = parseCommitObject(
        await gitObject(repositoryPath, "commit", signedSha),
        signedSha,
      );
      if (
        signed.author.line !== original.author.line ||
        signed.committer.line !== original.committer.line ||
        signed.encoding !== original.encoding ||
        !signed.message.equals(original.message)
      ) {
        throw new Error(
          `Signing changed preserved metadata or message for ${originalCommits[index]}`,
        );
      }
      await gitChecked(repositoryPath, [
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
        "verify-commit",
        signedSha,
      ]);
      parent = signedSha;
    }
    if (originals.length > 0) {
      await gitChecked(repositoryPath, ["reset", "--hard", parent]);
      const finalTree = (await gitChecked(repositoryPath, ["rev-parse", "HEAD^{tree}"])).trim();
      const expectedTree = (
        await gitChecked(repositoryPath, ["rev-parse", `${rebasedHead}^{tree}`])
      ).trim();
      if (finalTree !== expectedTree)
        throw new Error("Signed commit chain changed the rebased tree");
    }
    return originals.length;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeDiagnostics(path, snapshots, message, repositoryPath) {
  if (!path) return;
  const status = await git(repositoryPath, ["status", "--short", "--branch"]);
  const conflicts = await git(repositoryPath, ["ls-files", "-u"]);
  const conflictDiff = await git(repositoryPath, ["diff", "--cc"]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      `Starting refs: ${JSON.stringify(snapshots)}`,
      `Status: ${message}`,
      "Git status:",
      status.stdout,
      "Unmerged index entries:",
      conflicts.stdout,
      "Conflict diff (truncated at 40000 characters):",
      conflictDiff.stdout.slice(0, 40_000),
    ].join("\n"),
  );
}

async function ensureDirectory(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Export destination is not a regular directory: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
  }
}

async function writeExportFile(path, contents) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Export target is not a regular file: ${path}`);
    }
    if (!(await readFile(path)).equals(contents)) {
      throw new Error(`Export target already exists with different content: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(path, contents, { flag: "wx", mode: 0o644 });
  }
}

export async function exportResolutions({ repositoryPath, destinationPath } = {}) {
  if (!repositoryPath || !destinationPath) {
    throw new Error("repositoryPath and destinationPath are required");
  }
  const branch = (await gitChecked(destinationPath, ["branch", "--show-current"])).trim();
  if (branch !== "rebase-resolutions") {
    throw new Error("Export destination must be checked out on rebase-resolutions");
  }
  if ((await gitChecked(destinationPath, ["status", "--porcelain"])).trim()) {
    throw new Error("Export destination must have a clean worktree");
  }
  const destinationAbsolute = resolve(destinationPath);
  const destinationStat = await lstat(destinationAbsolute);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error("Export destination must be a real directory");
  }
  const cacheRootText = await gitChecked(repositoryPath, ["rev-parse", "--git-path", "rr-cache"]);
  const cacheRoot = resolve(repositoryPath, cacheRootText.trim());
  let cacheEntries = [];
  try {
    const rootStat = await lstat(cacheRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Git rr-cache must be a regular directory");
    }
    cacheEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const completed = [];
  for (const idEntry of cacheEntries) {
    if (!/^[0-9a-f]{40}$/.test(idEntry.name)) continue;
    if (idEntry.isSymbolicLink() || !idEntry.isDirectory()) {
      throw new Error(`Rerere ID entry is not a regular directory: ${idEntry.name}`);
    }
    const idDirectory = join(cacheRoot, idEntry.name);
    const variants = new Map();
    for (const fileEntry of await readdir(idDirectory, { withFileTypes: true })) {
      const match = /^(preimage|postimage)(\.\d+)?$/.exec(fileEntry.name);
      if (!match) continue;
      if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) {
        throw new Error(`Rerere variant is not a regular file: ${idEntry.name}/${fileEntry.name}`);
      }
      const [, side, suffix = ""] = match;
      const pair = variants.get(suffix) ?? {};
      if (pair[side])
        throw new Error(`Duplicate rerere variant: ${idEntry.name}/${fileEntry.name}`);
      pair[side] = await readFile(join(idDirectory, fileEntry.name));
      variants.set(suffix, pair);
    }
    for (const [suffix, pair] of variants) {
      // Unfinished rerere records lack one side; export completed pairs only.
      if (pair.preimage && pair.postimage) {
        completed.push({
          id: idEntry.name,
          suffix,
          preimage: pair.preimage,
          postimage: pair.postimage,
        });
      }
    }
  }

  const schemaPath = join(destinationAbsolute, SCHEMA_PATH);
  await writeExportFile(schemaPath, Buffer.from(SCHEMA_TEXT));
  const resolutionsRoot = join(destinationAbsolute, "resolutions");
  await ensureDirectory(resolutionsRoot);
  for (const pair of completed) {
    const idDirectory = join(resolutionsRoot, pair.id);
    await ensureDirectory(idDirectory);
    for (const side of ["preimage", "postimage"]) {
      await writeExportFile(join(idDirectory, `${side}${pair.suffix}`), pair[side]);
    }
  }
  return completed.length;
}

export async function rebaseDev({
  repositoryPath,
  remote = "origin",
  diagnosticsPath,
  signingKey,
  publicKey = SIGNING_PUBLIC_KEY,
} = {}) {
  if (!repositoryPath) throw new Error("repositoryPath is required");
  let snapshots = {};
  try {
    await validateSigningKey(signingKey, publicKey);
    const status = await gitChecked(repositoryPath, ["status", "--porcelain"]);
    if (status) throw new Error("Refusing to rebase a worktree with local changes");
    snapshots = await snapshotRefs(repositoryPath, remote);
    const maxContinuations = await replayCommitCount(
      repositoryPath,
      snapshots.upstream,
      snapshots.dev,
    );
    const originalCommits = await replayCommitIds(
      repositoryPath,
      snapshots.upstream,
      snapshots.dev,
    );
    await importResolutions(repositoryPath, snapshots.resolutions);
    await gitChecked(repositoryPath, ["checkout", "--detach", snapshots.dev]);
    const rebaseResult = await git(repositoryPath, [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=true",
      "-c",
      "user.name=Rebase staging",
      "-c",
      "user.email=rebase-staging@users.noreply.github.com",
      "rebase",
      "--merge",
      "--keep-empty",
      "--reapply-cherry-picks",
      "--empty=stop",
      snapshots.upstream,
    ]);
    if (rebaseResult.code !== 0) {
      await continueKnownResolutions(repositoryPath, rebaseResult, maxContinuations);
    }
    const signedCommits = await signRebasedCommits(
      repositoryPath,
      snapshots.upstream,
      originalCommits,
      signingKey,
      publicKey,
    );
    await writeDiagnostics(
      diagnosticsPath,
      snapshots,
      "Rebase completed; this snapshot will aid diagnosis if a later validation or publication step fails.",
      repositoryPath,
    );
    return { ...snapshots, signedCommits };
  } catch (error) {
    await writeDiagnostics(diagnosticsPath, snapshots, error.message, repositoryPath);
    throw error;
  }
}

export async function publishRebase({
  repositoryPath,
  remote = "origin",
  devSha,
  runId,
  runAttempt = "1",
}) {
  if (!/^[0-9a-f]{40}$/.test(devSha ?? "")) throw new Error("A captured dev SHA is required");
  if (!/^\d+$/.test(runId ?? "") || !/^\d+$/.test(runAttempt))
    throw new Error("Run id and attempt must be numeric");
  const backupRef = `refs/heads/backup/rebase-dev/${runId}-${runAttempt}`;
  const rewritten = (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim();
  const command = await git(repositoryPath, [
    "push",
    "--atomic",
    `--force-with-lease=${DEV_REF}:${devSha}`,
    `--force-with-lease=${backupRef}:`,
    remote,
    `${devSha}:${backupRef}`,
    `${rewritten}:${DEV_REF}`,
  ]);
  if (command.code !== 0) {
    throw new Error(`Atomic backup/rebase push failed (${command.code}): ${command.stderr.trim()}`);
  }
  return { backupRef, rewritten };
}

async function main() {
  const repositoryPath = process.cwd();
  if (process.argv[2] === "import") {
    const count = await importResolutions(repositoryPath, process.argv[3]);
    console.log(`Imported ${count} completed rerere pair(s)`);
    return;
  }
  if (process.argv[2] === "export") {
    const count = await exportResolutions({ repositoryPath, destinationPath: process.argv[3] });
    console.log(`Exported ${count} completed rerere pair(s)`);
    return;
  }
  if (process.argv[2] === "publish") {
    try {
      const result = await publishRebase({
        repositoryPath,
        devSha: process.env.DEV_SHA,
        runId: process.env.RUN_ID,
        runAttempt: process.env.RUN_ATTEMPT,
      });
      console.log(`Published backup ref ${result.backupRef} and rebased dev ${result.rewritten}`);
    } catch (error) {
      await writeDiagnostics(
        process.env.REBASE_DEV_DIAGNOSTICS,
        {
          dev: process.env.DEV_SHA,
          upstream: process.env.UPSTREAM_SHA,
          resolutions: process.env.RESOLUTIONS_SHA,
        },
        error.message,
        repositoryPath,
      );
      throw error;
    }
    return;
  }
  const signingKey = process.env.PASEO_REBASE_SSH_SIGNING_KEY;
  delete process.env.PASEO_REBASE_SSH_SIGNING_KEY;
  const snapshots = await rebaseDev({
    repositoryPath,
    diagnosticsPath: process.env.REBASE_DEV_DIAGNOSTICS,
    signingKey,
  });
  const outputsPath = process.env.GITHUB_OUTPUT;
  if (outputsPath) {
    await appendFile(
      outputsPath,
      `dev-sha=${snapshots.dev}\nupstream-sha=${snapshots.upstream}\nresolutions-sha=${snapshots.resolutions}\n`,
    );
  }
  console.log(`Rebase complete from upstream ${snapshots.upstream}; captured dev ${snapshots.dev}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
