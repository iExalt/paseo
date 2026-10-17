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
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  FORK_CONFIG_PATH,
  inspectForkRelease,
  assertForkReleasePreserved,
} from "../../scripts/fork-release-config.mjs";

const execFileAsync = promisify(execFile);
const RESOLUTION_REF = "refs/heads/rebase-resolutions";
const DEV_REF = "refs/heads/dev";
const UPSTREAM_REF = "refs/heads/upstream/main";
const CACHE_PREFIX = "resolutions/";
const SCHEMA_PATH = "schema.json";
const SCHEMA_TEXT = '{"version":1,"format":"git-rerere-cache-v1"}\n';
const DELETIONS_PATH = "deletions.json";
const RELEASE_PLEASE_CONFIG_PATH = "release-please-config.json";
const SIGNING_NAME = "Clement Liaw";
const SIGNING_EMAIL = "clliaw@nvidia.com";
// Every verified email of the GitHub account that registered the signing key. GitHub marks a
// replayed commit verified only when its committer email is one of these.
const SIGNING_EMAILS = new Set([SIGNING_EMAIL, "cman101202@gmail.com"]);
// GitHub's web merges commit as GitHub and carry GitHub's signature, which no replay can keep.
const WEB_FLOW_EMAIL = "noreply@github.com";
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
    throw new Error(`git cat-file ${type} ${oid} failed: ${(stderr ?? error.message).trim()}`, {
      cause: error,
    });
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

  const deletions = entries.find((entry) => entry.path === DELETIONS_PATH);
  if (deletions) {
    if (deletions.mode !== "100644")
      throw new Error("Unsupported path or file mode: deletions.json");
    parseDeletionResolutions(await gitChecked(repositoryPath, ["cat-file", "blob", deletions.oid]));
  }
  const cacheEntries = entries.filter(
    (entry) => ![SCHEMA_PATH, DELETIONS_PATH].includes(entry.path),
  );
  const pairs = new Map();
  for (const entry of cacheEntries) {
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
  for (const entry of cacheEntries) {
    const relative = entry.path.slice(CACHE_PREFIX.length);
    const destination = join(resolvedCacheRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    const content = await gitBlob(repositoryPath, entry.oid);
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  }
  return pairs.size;
}

export function parseDeletionResolutions(text) {
  const records = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("Deletion resolutions must be an array");
  const keys = new Set();
  for (const record of records) {
    if (
      !record ||
      Object.keys(record).sort().join() !== "commit,path,stages,upstream" ||
      !/^[0-9a-f]{40}$/.test(record.commit) ||
      !/^[0-9a-f]{40}$/.test(record.upstream) ||
      typeof record.path !== "string" ||
      !record.path
        .split("/")
        .every(
          (part) =>
            /^[A-Za-z0-9_@+.-]+$/.test(part) && ![".", "..", ".git"].includes(part.toLowerCase()),
        ) ||
      !Array.isArray(record.stages) ||
      record.stages.length !== 2 ||
      record.stages[0]?.stage !== 1 ||
      ![2, 3].includes(record.stages[1]?.stage) ||
      record.stages.some(
        (entry) =>
          !entry ||
          Object.keys(entry).sort().join() !== "mode,oid,stage" ||
          entry.mode !== "100644" ||
          !/^[0-9a-f]{40}$/.test(entry.oid),
      )
    )
      throw new Error("Invalid exact deletion resolution");
    const key = `${record.upstream}:${record.commit}:${record.path}`;
    if (keys.has(key)) throw new Error("Duplicate deletion resolution");
    keys.add(key);
  }
  return records;
}

async function loadDeletionResolutions(repositoryPath, resolutionSha) {
  const entry = await gitChecked(repositoryPath, ["ls-tree", resolutionSha, "--", DELETIONS_PATH]);
  if (!entry) return [];
  return parseDeletionResolutions(
    await gitChecked(repositoryPath, ["show", `${resolutionSha}:${DELETIONS_PATH}`]),
  );
}

async function applyDeletionResolutions(repositoryPath, records, upstream) {
  const commit = (await gitChecked(repositoryPath, ["rev-parse", "REBASE_HEAD"])).trim();
  const matching = records.filter(
    (record) => record.commit === commit && record.upstream === upstream,
  );
  const pending = [];
  for (const record of matching) {
    const actual = await gitChecked(repositoryPath, ["ls-files", "-u", "-z", "--", record.path]);
    const expected = record.stages
      .map(({ mode, oid, stage }) => `${mode} ${oid} ${stage}\t${record.path}\0`)
      .join("");
    if (actual !== expected) throw new Error(`Deletion resolution index mismatch: ${record.path}`);
    pending.push(record.path);
  }
  for (const path of pending) {
    await gitChecked(repositoryPath, ["rm", "--", path]);
  }
  return pending.length;
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

function isReusableRerereStop(result, paths, indexPaths, deletions = 0) {
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  const reusedRecords = diagnostics.match(/^Staged '.+' using previous resolution\.$/gm) ?? [];
  return (
    result.code !== 0 &&
    /CONFLICT \(/.test(diagnostics) &&
    /could not apply [0-9a-f]+/.test(diagnostics) &&
    (reusedRecords.length > 0 || deletions > 0) &&
    paths.length === 0 &&
    indexPaths.length > 0
  );
}

async function continueKnownResolutions(
  repositoryPath,
  firstResult,
  maxContinuations,
  deletionRecords = [],
  upstream,
) {
  let result = firstResult;
  for (let attempt = 0; attempt < maxContinuations; attempt += 1) {
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
    const conflictStop =
      result.code !== 0 &&
      /CONFLICT \(/.test(`${result.stdout}\n${result.stderr}`) &&
      /could not apply [0-9a-f]+/.test(`${result.stdout}\n${result.stderr}`);
    const deletions =
      state.code === 0 && directoryExists && conflictStop
        ? await applyDeletionResolutions(repositoryPath, deletionRecords, upstream)
        : 0;
    const conflicts = await unmergedPaths(repositoryPath);
    const staged = await stagedPaths(repositoryPath);
    if (
      state.code !== 0 ||
      !directoryExists ||
      !isReusableRerereStop(result, conflicts, staged, deletions)
    ) {
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
    await gitChecked(repositoryPath, [
      "rev-list",
      "--count",
      "--no-merges",
      `${upstreamSha}..${devSha}`,
    ])
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

// A merge whose tree differs from Git's own merge of its parents holds hand edits that a
// replay, which drops merges, would silently lose.
async function assertCleanMerge(repositoryPath, sha) {
  const parents = (await gitChecked(repositoryPath, ["rev-list", "--parents", "-n", "1", sha]))
    .trim()
    .split(" ")
    .slice(1);
  const merged = await git(repositoryPath, ["merge-tree", "--write-tree", ...parents]);
  const tree = (await gitChecked(repositoryPath, ["rev-parse", `${sha}^{tree}`])).trim();
  if (parents.length !== 2 || merged.code !== 0 || merged.stdout.split("\n")[0] !== tree) {
    throw new Error(`Merge ${sha} is not Git's clean merge of its parents; linearize it by hand`);
  }
}

// The commits rebase replays, in its order: merges dropped, the rest topologically sorted.
async function replayCommitIds(repositoryPath, upstreamSha, devSha) {
  const range = `${upstreamSha}..${devSha}`;
  const merges = (await gitChecked(repositoryPath, ["rev-list", "--merges", range])).trim();
  for (const merge of merges ? merges.split("\n") : [])
    await assertCleanMerge(repositoryPath, merge);
  const output = await gitChecked(repositoryPath, [
    "rev-list",
    "--reverse",
    "--topo-order",
    "--no-merges",
    range,
  ]);
  return output.trim() ? output.trim().split("\n") : [];
}

function replayCommitter(original, sha) {
  if (SIGNING_EMAILS.has(original.committer.email)) return original.committer;
  if (original.committer.email !== WEB_FLOW_EMAIL) {
    throw new Error(
      `Cannot sign replay of ${sha} from unrecognized committer email ${original.committer.email}`,
    );
  }
  const { date } = original.committer;
  return {
    line: `committer ${SIGNING_NAME} <${SIGNING_EMAIL}> ${date}`,
    name: SIGNING_NAME,
    email: SIGNING_EMAIL,
    date,
  };
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
    originals.push({ ...original, committer: replayCommitter(original, originalCommits[index]) });
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
    await writeFile(allowedSignersPath, `${[...SIGNING_EMAILS].join(",")} ${trustedPublicKey}\n`, {
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
          `Signing changed replayed metadata or message for ${originalCommits[index]}`,
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

// The newest replayed commit that release-please may treat as the last release
// (a paseo-v* tag or the configured last-release-sha) and its rewritten SHA.
export function releaseBoundary(originalCommits, rebasedCommits, boundaryShas) {
  if (originalCommits.length !== rebasedCommits.length)
    throw new Error("Release boundary needs every replayed commit mapped");
  const candidates = new Set(boundaryShas);
  for (let index = originalCommits.length - 1; index >= 0; index -= 1) {
    if (candidates.has(originalCommits[index]))
      return { original: originalCommits[index], rewritten: rebasedCommits[index] };
  }
  return null;
}

export function parseReleaseTags(text) {
  const commits = new Map();
  for (const line of text.trim().split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(paseo-v\d+\.\d+\.\d+)(\^\{\})?$/.exec(line);
    // An annotated tag's peeled row names its commit; prefer it over the tag object.
    if (match && (match[3] || !commits.has(match[2]))) commits.set(match[2], match[1]);
  }
  return new Set(commits.values());
}

async function releaseTagCommits(repositoryPath, remote) {
  return parseReleaseTags(
    await gitChecked(repositoryPath, ["ls-remote", "--tags", remote, "refs/tags/paseo-v*"]),
  );
}

// Adds one signed commit on HEAD that writes path, with the replay's committer.
async function commitSignedFile(
  repositoryPath,
  { path, contents, message, signingKey, publicKey },
) {
  const parent = (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(repositoryPath, path), contents);
  await gitChecked(repositoryPath, ["add", "--", path]);
  const tree = (await gitChecked(repositoryPath, ["write-tree"])).trim();
  const unsigned = (
    await gitChecked(repositoryPath, ["commit-tree", tree, "-p", parent, "-m", message], {
      env: {
        GIT_AUTHOR_NAME: "Clement Liaw",
        GIT_AUTHOR_EMAIL: SIGNING_EMAIL,
        GIT_COMMITTER_NAME: "Clement Liaw",
        GIT_COMMITTER_EMAIL: SIGNING_EMAIL,
      },
    })
  ).trim();
  await gitChecked(repositoryPath, ["reset", "--hard", unsigned]);
  return signRebasedCommits(repositoryPath, parent, [unsigned], signingKey, publicKey);
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

async function readResolutionVariants(idDirectory, id) {
  const variants = new Map();
  for (const entry of await readdir(idDirectory, { withFileTypes: true })) {
    const match = /^(preimage|postimage)(\.\d+)?$/.exec(entry.name);
    if (!match) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Rerere variant is not a regular file: ${id}/${entry.name}`);
    }
    const [, side, suffix = ""] = match;
    const pair = variants.get(suffix) ?? {};
    if (pair[side]) throw new Error(`Duplicate rerere variant: ${id}/${entry.name}`);
    pair[side] = await readFile(join(idDirectory, entry.name));
    variants.set(suffix, pair);
  }
  return variants;
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
  if (!destinationStat.isDirectory()) {
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
    const variants = await readResolutionVariants(idDirectory, idEntry.name);
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
    if (signingKey && !signingKey.endsWith("\n")) signingKey += "\n";
    await validateSigningKey(signingKey, publicKey);
    const status = await gitChecked(repositoryPath, ["status", "--porcelain"]);
    if (status) throw new Error("Refusing to rebase a worktree with local changes");
    snapshots = await snapshotRefs(repositoryPath, remote);
    const before = await inspectForkRelease((file) =>
      gitChecked(repositoryPath, ["show", `${snapshots.dev}:${file}`]),
    );
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
    const deletionRecords = await loadDeletionResolutions(repositoryPath, snapshots.resolutions);
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
      await continueKnownResolutions(
        repositoryPath,
        rebaseResult,
        maxContinuations,
        deletionRecords,
        snapshots.upstream,
      );
    }
    const signedCommits = await signRebasedCommits(
      repositoryPath,
      snapshots.upstream,
      originalCommits,
      signingKey,
      publicKey,
    );
    const rebasedCommits = await replayCommitIds(
      repositoryPath,
      snapshots.upstream,
      (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim(),
    );
    const readRelease = () =>
      inspectForkRelease((file) => readFile(join(repositoryPath, file), "utf8"));
    assertForkReleasePreserved(before, await readRelease());
    let provenanceCommits = 0;
    if (before.config.upstreamBase !== snapshots.upstream) {
      // Keep replayed author/message metadata intact. Provenance is a separate,
      // signed commit, and the downstream routine gate validates this final HEAD.
      provenanceCommits = await commitSignedFile(repositoryPath, {
        path: FORK_CONFIG_PATH,
        contents: `${JSON.stringify({ ...before.config, upstreamBase: snapshots.upstream }, null, 2)}\n`,
        message: "chore(rebase): capture incorporated upstream",
        signingKey,
        publicKey,
      });
    }
    // release-please finds the last release by walking dev for its tagged commit,
    // which the replay just rewrote. Point it at the rewritten copy instead.
    let boundaryCommits = 0;
    const releaseConfig = JSON.parse(
      await readFile(join(repositoryPath, RELEASE_PLEASE_CONFIG_PATH), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      }),
    );
    const boundary = releaseBoundary(originalCommits, rebasedCommits, [
      ...(await releaseTagCommits(repositoryPath, remote)),
      releaseConfig["last-release-sha"],
    ]);
    if (
      boundary &&
      boundary.rewritten !== boundary.original &&
      boundary.rewritten !== releaseConfig["last-release-sha"]
    ) {
      boundaryCommits = await commitSignedFile(repositoryPath, {
        path: RELEASE_PLEASE_CONFIG_PATH,
        contents: `${JSON.stringify({ ...releaseConfig, "last-release-sha": boundary.rewritten }, null, 2)}\n`,
        message: "chore(rebase): point release-please at the rebased release",
        signingKey,
        publicKey,
      });
    }
    assertForkReleasePreserved(before, await readRelease(), snapshots.upstream);
    await writeDiagnostics(
      diagnosticsPath,
      snapshots,
      "Rebase completed; this snapshot will aid diagnosis if a later validation or publication step fails.",
      repositoryPath,
    );
    return { ...snapshots, signedCommits, provenanceCommits, boundaryCommits };
  } catch (error) {
    await writeDiagnostics(diagnosticsPath, snapshots, error.message, repositoryPath);
    throw error;
  }
}

async function checkedTree(repositoryPath, expectedSha) {
  const sha = (await gitChecked(repositoryPath, ["rev-parse", "HEAD"])).trim();
  if (expectedSha !== undefined && sha !== expectedSha)
    throw new Error("HEAD differs from the tested SHA");
  const status = await gitChecked(repositoryPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status) throw new Error("Validation requires a clean tracked and nonignored working tree");

  // Fresh hosted checkouts may generate ignored build outputs, but must not load
  // local environment overrides. This is not an audit of every possible ignored input.
  const roots = [repositoryPath, join(repositoryPath, "plugins")];
  const packages = join(repositoryPath, "packages");
  const entries = await readdir(packages, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory()) roots.push(join(packages, entry.name));
  }
  for (const root of roots) {
    const names = await readdir(root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.filter((candidate) =>
      /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(candidate),
    )) {
      const override = join(root, name);
      const tracked = await git(repositoryPath, [
        "--literal-pathspecs",
        "ls-files",
        "--error-unmatch",
        "--",
        relativePath(repositoryPath, override),
      ]);
      if (tracked.code !== 0)
        throw new Error(`Local environment override is unsupported: ${override}`);
    }
  }
  return sha;
}

function runRoutine(repositoryPath) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("mise", ["run", "--skip-tools", "ci:routine"], {
      cwd: repositoryPath,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Routine verification failed (${signal ?? code})`));
    });
  });
}

export async function validateRebase({ repositoryPath, runChecks = runRoutine }) {
  const testedSha = await checkedTree(repositoryPath);
  await runChecks(repositoryPath);
  await checkedTree(repositoryPath, testedSha);
  return testedSha;
}

export async function publishRebase({
  repositoryPath,
  remote = "origin",
  devSha,
  testedSha,
  runId,
  runAttempt = "1",
}) {
  if (!/^[0-9a-f]{40}$/.test(devSha ?? "")) throw new Error("A captured dev SHA is required");
  if (!/^[0-9a-f]{40}$/.test(testedSha ?? "")) throw new Error("A tested SHA is required");
  if (!/^\d+$/.test(runId ?? "") || !/^\d+$/.test(runAttempt))
    throw new Error("Run id and attempt must be numeric");
  const backupRef = `refs/heads/backup/rebase-dev/${runId}-${runAttempt}`;
  const rewritten = await checkedTree(repositoryPath, testedSha);
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
        testedSha: process.env.TESTED_SHA,
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
  if (process.argv[2] === "validate") {
    const testedSha = await validateRebase({ repositoryPath });
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `tested-sha=${testedSha}\n`);
    console.log(`Routine verification passed for ${testedSha}`);
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
