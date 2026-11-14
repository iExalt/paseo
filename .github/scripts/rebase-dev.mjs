import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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

async function git(repositoryPath, args, options = {}) {
  try {
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

  try {
      cwd: repositoryPath,
      encoding: "buffer",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : error.stderr;
  }
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

  const diagnostics = `${result.stdout}\n${result.stderr}`;
  return (
    result.code !== 0 &&
    /CONFLICT \(/.test(diagnostics) &&
    /could not apply [0-9a-f]+/.test(diagnostics) &&
    paths.length === 0 &&
  );
}

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

  if (!repositoryPath) throw new Error("repositoryPath is required");
  let snapshots = {};
  try {
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
    await importResolutions(repositoryPath, snapshots.resolutions);
    await gitChecked(repositoryPath, ["checkout", "--detach", snapshots.dev]);
    const rebaseResult = await git(repositoryPath, [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=true",
      "rebase",
      "--merge",
      "--keep-empty",
      "--reapply-cherry-picks",
      "--empty=stop",
      snapshots.upstream,
    ]);
    if (rebaseResult.code !== 0) {
    }
    const readRelease = () =>
      inspectForkRelease((file) => readFile(join(repositoryPath, file), "utf8"));
    assertForkReleasePreserved(before, await readRelease());
    let provenanceCommits = 0;
    if (before.config.upstreamBase !== snapshots.upstream) {
      // Keep replayed author/message metadata intact. Provenance is a separate,
      // signed commit, and the downstream routine gate validates this final HEAD.
        signingKey,
        publicKey,
    }
    assertForkReleasePreserved(before, await readRelease(), snapshots.upstream);
    await writeDiagnostics(
      diagnosticsPath,
      snapshots,
      "Rebase completed; this snapshot will aid diagnosis if a later validation or publication step fails.",
      repositoryPath,
    );
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
  const snapshots = await rebaseDev({
    repositoryPath,
    diagnosticsPath: process.env.REBASE_DEV_DIAGNOSTICS,
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
