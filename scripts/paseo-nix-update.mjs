#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareForkVersions,
  forkReleaseTag,
  forkVersionFromTag,
} from "../packages/protocol/src/fork-version.ts";
import {
  validateForkReleaseManifest,
  FORK_RELEASE_LINEAGE,
} from "../packages/protocol/src/release-manifest-v2.ts";
import {
  DATA_ROOT,
  ACTIVE_PROFILE,
  REPOSITORY,
  RELEASE_MANIFEST_ASSET,
  RELEASE_SIGNATURE_ASSET,
  NIX_RELEASE_PUBLIC_KEY,
  withOperationLock,
  verifySignedJsonBytes,
  assertMacArm,
  downloadAsset,
  fetchHttps,
  assertFreeSpace,
  writeJson,
  profileGenerations,
  setProfile,
  extractNixCacheTar,
  nix,
  nixEnv,
  nixOptions,
  isNixClosureEntry,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  readLegacyRecoverySnapshot,
  loadLegacyReceipt,
  verifyLegacyImportedClosure,
  runLegacyRecovery,
} from "./paseo-nix-update-legacy.mjs";
import { prepareIndexedCache } from "./paseo-nix-update-delta.mjs";
import {
  emptyState,
  validateState,
  assertCurrent,
  validateTarget,
  executeTransaction,
  reconcileTransaction,
  retainedState,
} from "./paseo-nix-update-state.mjs";
import {
  appBundle,
  launchDesktopApp,
  syncDesktopApp,
  waitForExit,
} from "./paseo-nix-update-macos.mjs";

export {
  DATA_ROOT,
  ACTIVE_PROFILE,
  NIX_RELEASE_PUBLIC_KEY,
  setProfile,
  extractNixCacheTar,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
};
export const STATE_ROOT = join(DATA_ROOT, "semver-v1");
const STAGING_PROFILE = join(STATE_ROOT, "staging-profile");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (manifest) => `${manifest.sourceSha}-v${manifest.version}`;

export function verifyReleaseManifestBytes(bytes, signature, publicKey) {
  const manifest = verifySignedJsonBytes(bytes, signature, publicKey);
  validateForkReleaseManifest(manifest);
  return manifest;
}

export function macArtifact(manifest) {
  validateForkReleaseManifest(manifest);
  return manifest.artifacts.find(
    (entry) => entry.platform === "macos" && entry.kind === "nix-desktop",
  );
}

const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 30 * 60_000;

// Unauthenticated REST calls share GitHub's 60-per-hour budget per IP address,
// often a whole office's. Release pages and download URLs do not count against
// it, so the updater resolves and downloads everything through them.
export function releaseDownloadUrl(tag, name) {
  assert.ok(forkVersionFromTag(tag) !== null, "Not a fork release tag");
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid release asset name");
  return `${RELEASES}/download/${tag}/${name}`;
}

export function httpFailure(what, response, now = Date.now()) {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  const limited =
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (!limited) return new Error(`GitHub returned HTTP ${response.status} for ${what}.`);
  let at = Number.NaN;
  if (reset > 0) at = reset * 1000;
  else if (retryAfter > 0) at = now + retryAfter * 1000;
  return new Error(
    `GitHub rate limit reached while fetching ${what}. ${
      Number.isFinite(at) ? `Retry after ${new Date(at).toISOString()}.` : "Retry later."
    }`,
  );
}

export async function resolveLatestTag(fetchOnce = fetch) {
  const response = await fetchOnce(`${RELEASES}/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (![301, 302, 303, 307, 308].includes(response.status))
    throw httpFailure("the latest release", response);
  const location = new URL(response.headers.get("location") ?? "", `${RELEASES}/latest`);
  const prefix = `/${REPOSITORY}/releases/tag/`;
  assert.ok(
    location.origin === "https://github.com" &&
      location.pathname.startsWith(prefix) &&
      !location.search,
    "GitHub returned an unexpected latest release location",
  );
  const tag = decodeURIComponent(location.pathname.slice(prefix.length));
  assert.ok(forkVersionFromTag(tag) !== null, `Latest GitHub release ${tag} is not a fork release`);
  return tag;
}

export async function fetchMetadata(url, what) {
  const response = await fetchHttps(
    url,
    { Accept: "application/octet-stream" },
    { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
  );
  if (!response.ok || !response.body) throw httpFailure(what, response);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= MAX_METADATA_BYTES, `GitHub ${what} exceeds its size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// GitHub's Latest is never a draft or prerelease. An invalid latest release
// fails closed instead of falling back to an older one; high-water still
// refuses anything at or below the newest activated version.
export async function latestVerifiedRelease({
  resolveTag = resolveLatestTag,
  fetchBytes = fetchMetadata,
  publicKey,
} = {}) {
  const tag = await resolveTag();
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchBytes(releaseDownloadUrl(tag, RELEASE_MANIFEST_ASSET), "the release manifest"),
    fetchBytes(releaseDownloadUrl(tag, RELEASE_SIGNATURE_ASSET), "the release signature"),
  ]);
  const manifest = verifyReleaseManifestBytes(manifestBytes, signatureBytes, publicKey);
  assert.equal(manifest.releaseTag, tag, "Signed release manifest names another release");
  assert.ok(macArtifact(manifest), "Latest release has no macOS Nix desktop artifact");
  return { tag, manifest, manifestBytes, signatureBytes };
}

export function validateNixClosureManifest(bytes, manifest) {
  return validateNixArtifactClosure(bytes, macArtifact(manifest), manifest);
}

export function validateNixArtifactClosure(bytes, artifact, manifest) {
  assert.equal(bytes.length, artifact.closureManifest.bytes);
  assert.equal(
    hash(bytes),
    artifact.closureManifest.sha256,
    "Closure manifest differs from signed bytes",
  );
  const closure = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.equal(closure.schemaVersion, 2);
  assert.equal(closure.kind, "paseo-verification-candidate");
  assert.equal(closure.sourceSha, manifest.sourceSha);
  assert.equal(closure.forkVersion, manifest.version);
  assert.equal(closure.system, artifact.system);
  assert.equal(closure.outputPath, artifact.outputPath);
  assert.equal(closure.provenance, "local-ci-build");
  assert.ok(Array.isArray(closure.closure) && closure.closure.length > 0);
  let previous = "";
  for (const entry of closure.closure) {
    assert.ok(
      isNixClosureEntry(entry) && entry.path > previous,
      "Invalid, duplicate or unsorted Nix closure entry",
    );
    previous = entry.path;
  }
  assert.ok(closure.closure.some((entry) => entry.path === artifact.outputPath));
  return closure;
}

async function verifyClosure(receipt) {
  const closure = validateNixClosureManifest(receipt.nixManifestBytes, receipt.manifest);
  const output = macArtifact(receipt.manifest).outputPath;
  nix(["store", "verify", "--recursive", "--sigs-needed", "1", ...nixOptions(), output], {
    quiet: true,
  });
  const actual = JSON.parse(
    nix(["path-info", "--json", "--recursive", ...nixOptions(), output], { capture: true }).stdout,
  );
  const expected = closure.closure.map(({ path, narHash, narSize }) => ({
    path,
    narHash,
    narSize,
  }));
  const imported = Object.entries(actual)
    .map(([path, info]) => ({ path, narHash: info.narHash, narSize: info.narSize }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(imported, expected, "Imported Nix closure differs from signed manifest");
}

async function readOptional(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function loadReceipt(target) {
  validateTarget(target, { pending: true });
  if (target.lineage === "legacy-v1") {
    const receipt = await loadLegacyReceipt(join(DATA_ROOT, "receipts", target.identity));
    assert.equal(receipt.manifest.macOS.outputPath, target.outputPath);
    return receipt;
  }
  const directory = join(STATE_ROOT, "receipts", target.identity);
  const [manifestBytes, signatureBytes, nixManifestBytes] = await Promise.all([
    readFile(join(directory, "release-manifest.json")),
    readFile(join(directory, "release-manifest.sig")),
    readFile(join(directory, "nix-closure-manifest.json")),
  ]);
  const manifest = verifyReleaseManifestBytes(manifestBytes, signatureBytes);
  assert.equal(identity(manifest), target.identity);
  assert.equal(manifest.version, target.version);
  assert.equal(macArtifact(manifest).outputPath, target.outputPath);
  validateNixClosureManifest(nixManifestBytes, manifest);
  return { manifest, manifestBytes, signatureBytes, nixManifestBytes };
}

async function persistReceipt(receipt) {
  const root = join(STATE_ROOT, "receipts");
  const destination = join(root, identity(receipt.manifest));
  const files = [
    ["release-manifest.json", receipt.manifestBytes],
    ["release-manifest.sig", receipt.signatureBytes],
    ["nix-closure-manifest.json", receipt.nixManifestBytes],
  ];
  if (await exists(destination)) {
    for (const [name, bytes] of files)
      assert.deepEqual(
        await readFile(join(destination, name)),
        bytes,
        "An immutable receipt already exists with different bytes",
      );
    return;
  }
  const temporary = await mkdtemp(join(root, ".receipt-"));
  try {
    for (const [name, bytes] of files)
      await writeFile(join(temporary, name), bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function targetFor(manifest) {
  return {
    lineage: FORK_RELEASE_LINEAGE,
    generation: null,
    identity: identity(manifest),
    outputPath: macArtifact(manifest).outputPath,
    version: manifest.version,
  };
}

/** Runs the fast path; on any failure, reports it and runs the full download. */
export async function importWithFallback({ fast, full, warn }) {
  try {
    return await fast();
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return full();
  }
}

async function stageRelease(verified) {
  const artifact = macArtifact(verified.manifest);
  const nixManifestBytes = await fetchMetadata(
    releaseDownloadUrl(verified.tag, artifact.closureManifest.name),
    "the Nix closure manifest",
  );
  const closure = validateNixClosureManifest(nixManifestBytes, verified.manifest);
  const receipt = { ...verified, nixManifestBytes };
  const importCache = async (cache) => {
    nix(localCacheCopyArgs(cache, artifact.outputPath), { quiet: true });
    nix(localCacheCopySignaturesArgs(cache, artifact.outputPath), { quiet: true });
    await verifyClosure(receipt);
  };
  const directory = await mkdtemp(join(STATE_ROOT, "download-"));
  const indexed = join(directory, "indexed");
  try {
    await importWithFallback({
      // Fetches only the paths this store lacks: a delta against an installed
      // release, else that path's range of the tar (paseo-nix-update-delta.mjs).
      async fast() {
        await mkdir(indexed, { mode: 0o700 });
        const { cache } = await prepareIndexedCache({
          tag: verified.tag,
          artifact,
          closure,
          directory: indexed,
          downloadUrl: releaseDownloadUrl,
          fetchBytes: fetchMetadata,
          freeSpace: (transferBytes, importBytes) =>
            assertFreeSpace(transferBytes, importBytes, STATE_ROOT),
          signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        });
        await importCache(cache);
      },
      async full() {
        await rm(indexed, { recursive: true, force: true });
        await assertFreeSpace(
          artifact.bytes,
          closure.closure.reduce((sum, entry) => sum + entry.narSize, 0),
          STATE_ROOT,
        );
        const file = join(directory, artifact.name);
        const url = releaseDownloadUrl(verified.tag, artifact.name);
        await downloadAsset({ name: artifact.name, url, size: artifact.bytes }, file, {
          expectedBytes: artifact.bytes,
          expectedSha256: artifact.sha256,
          maxBytes: artifact.bytes,
          signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        });
        const cache = join(directory, "cache");
        await extractNixCacheTar(file, cache);
        await importCache(cache);
      },
      warn: (message) =>
        process.stderr.write(
          `Partial update download failed (${message.slice(0, 2000)}); downloading the full archive.\n`,
        ),
    });
    await persistReceipt(receipt);
    setProfile(STAGING_PROFILE, artifact.outputPath, { quiet: true });
    const target = targetFor(verified.manifest);
    await writeJson(join(STATE_ROOT, "staged.json"), target);
    return target;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Deleting a generation only drops its GC root; Nix still keeps any store path a
// running process holds, so an app left running on a pruned version survives GC.
async function pruneGenerations(keep) {
  const stale = (await profileGenerations(ACTIVE_PROFILE))
    .filter((entry) => !entry.current && !keep.includes(entry.generation))
    .map((entry) => String(entry.generation));
  if (stale.length > 0)
    nixEnv(["--profile", ACTIVE_PROFILE, "--delete-generations", ...stale], { quiet: true });
  if (await exists(STAGING_PROFILE))
    nixEnv(["--profile", STAGING_PROFILE, "--delete-generations", "old"], { quiet: true });
  // Fork state exists, so legacy commands refuse to run and their staging profile is dead.
  for (const name of await readdir(DATA_ROOT)) {
    const link = join(DATA_ROOT, name);
    if (/^staging-profile(-[1-9][0-9]*-link)?$/.test(name) && (await lstat(link)).isSymbolicLink())
      await rm(link);
  }
}

async function current() {
  const generations = await profileGenerations(ACTIVE_PROFILE);
  return generations.find((entry) => entry.current) ?? null;
}

async function verifyState(state) {
  validateState(state);
  for (const target of [state.legacyRecovery, ...state.generations].filter(Boolean))
    await loadReceipt(target);
  return state;
}

function productionAdapters() {
  const stateFile = join(STATE_ROOT, "profile-state.json");
  const journalFile = join(STATE_ROOT, "pending-activation.json");
  return {
    current,
    async readState() {
      const state = await readOptional(stateFile);
      return state && verifyState(state);
    },
    async readJournal() {
      const journal = await readOptional(journalFile);
      if (journal) await verifyState(journal.before);
      return journal;
    },
    writeState: (state) => writeJson(stateFile, validateState(state)),
    writeJournal: (journal) => writeJson(journalFile, journal),
    clearJournal: () => rm(journalFile, { force: true }),
    async verifyTarget(target) {
      const receipt = await loadReceipt(target);
      if (target.lineage === "legacy-v1")
        await verifyLegacyImportedClosure(receipt.manifest, receipt.nixManifestBytes, {
          quiet: true,
        });
      else await verifyClosure(receipt);
      if (target.generation !== null) {
        const retained = await profileGenerations(ACTIVE_PROFILE);
        assert.ok(
          retained.some(
            (entry) =>
              entry.generation === target.generation && entry.outputPath === target.outputPath,
          ),
          "Recovery target generation is no longer retained",
        );
      }
    },
    selectTarget: (target) => setProfile(ACTIVE_PROFILE, target.outputPath, { quiet: true }),
    pruneGenerations,
    syncDesktopApp,
  };
}

function summary(target) {
  if (!target || target.lineage === "legacy-v1") return null;
  return {
    releaseTag: forkReleaseTag(target.version),
    version: target.version,
    outputPath: target.outputPath,
  };
}

async function prepareState(command, adapters) {
  let state = (await adapters.readState()) ?? emptyState();
  const actual = await adapters.current();
  if (state.current === null && actual !== null) {
    assert.equal(
      command,
      "migrate",
      "Existing profile requires explicit manual migration (paseo-nix-update migrate)",
    );
    const legacy = await adapters.legacySnapshot();
    assert.ok(legacy, "Manual migration needs a verified legacy snapshot");
    state = { ...state, current: legacy.target, legacyRecovery: legacy.target };
  }
  assertCurrent(state, actual);
  return state;
}

async function prepareStaged(state, command, adapters) {
  const staged = await adapters.readStaged();
  if (!staged) return { staged: null, completed: false };
  await adapters.loadReceipt(staged);
  if (state.highWater && compareForkVersions(staged.version, state.highWater.version) <= 0) {
    await adapters.clearStaged();
    return {
      staged: null,
      completed:
        staged.identity === state.current?.identity && ["activate", "migrate"].includes(command),
    };
  }
  return { staged, completed: false };
}

function recoveryTarget(state, command) {
  const target =
    command === "reactivate-high-water"
      ? state.highWater
      : [state.legacyRecovery, ...state.generations]
          .filter((entry) => entry && entry.generation < state.current?.generation)
          .sort((a, b) => b.generation - a.generation)[0];
  assert.ok(target, "No retained verified recovery target is available");
  return target;
}

async function executeMutation(command, state, staged, adapters) {
  if (command === "activate" || command === "migrate") {
    assert.ok(staged, "No verified fork release is staged");
    const next = await executeTransaction(state, command, staged, adapters);
    await adapters.clearStaged();
    return { state: next, staged: null };
  }
  if (command === "rollback" || command === "reactivate-high-water") {
    assert.equal(staged, null, "Another release is staged; finish it before recovery");
    const target = recoveryTarget(state, command);
    if (target.identity !== state.current?.identity)
      state = await executeTransaction(state, command, target, adapters);
  }
  return { state, staged };
}

const SWITCHES = new Set(["activate", "migrate", "rollback", "reactivate-high-water"]);

// Runs after replays too, so a retry after an interrupted command still prunes and registers.
async function finishSwitch(command, state, adapters) {
  if (!SWITCHES.has(command) || state.current === null) return state;
  const retained = retainedState(state);
  const kept = [retained.legacyRecovery, ...retained.generations].filter(Boolean);
  // State drops pruned targets before their profile generations go, so a crash
  // in between leaves only unrecorded generations, which the next switch deletes.
  if (kept.length !== [state.legacyRecovery, ...state.generations].filter(Boolean).length)
    await adapters.writeState(retained);
  await adapters.pruneGenerations(kept.map((entry) => entry.generation));
  await adapters.syncDesktopApp(retained.current.outputPath);
  return retained;
}

function commandResult(command, state, staged, latest, latestError) {
  return {
    ok: true,
    action: command,
    active: summary(state.current),
    staged: summary(staged),
    ...(latest ? { latest: summary(latest) } : {}),
    ...(latestError ? { latestError } : {}),
    highWaterVersion: state.highWater?.version ?? null,
    canStage: Boolean(
      latest &&
      (!state.highWater || compareForkVersions(latest.version, state.highWater.version) > 0),
    ),
    message:
      state.current?.lineage === "legacy-v1"
        ? "Verified legacy recovery generation is active; fork high-water is preserved."
        : "Running processes were left untouched.",
  };
}

/** Shared command controller; fixtures replace external IO, never production trust pins. */
export async function executeCommand(command, adapters) {
  await adapters.assertNoLegacyJournal();
  const recovered = await reconcileTransaction(adapters);
  if (recovered?.switched) await adapters.clearStaged();
  let state = await prepareState(command, adapters);
  const prepared = await prepareStaged(state, command, adapters);
  let staged = prepared.staged;
  const completedReplay =
    prepared.completed ||
    (recovered?.switched && recovered.action === command) ||
    (command === "migrate" && state.highWater !== null && staged === null);
  let latest;
  let latestError;
  if (!completedReplay && ["check", "stage", "migrate"].includes(command)) {
    let candidate;
    try {
      candidate = await adapters.latest();
    } catch (error) {
      // A failed lookup must not hide the local profile facts from check.
      if (command !== "check") throw error;
      latestError = error instanceof Error ? error.message : "Latest release lookup failed";
    }
    if (candidate) latest = targetFor(candidate.manifest);
    if (candidate && command !== "check") {
      assert.ok(
        !state.highWater || compareForkVersions(latest.version, state.highWater.version) > 0,
        "Candidate does not exceed the fork semver high-water mark",
      );
      staged = await adapters.stage(candidate);
    }
  }
  if (!completedReplay)
    ({ state, staged } = await executeMutation(command, state, staged, adapters));
  state = await finishSwitch(command, state, adapters);
  return commandResult(command, state, staged, latest, latestError);
}

// The desktop app hands its restart to this command: once the app has exited,
// nothing runs from /Applications/Paseo.app and the copy can be replaced.
async function installApp(args) {
  const pid = args[0] === "--after-exit" && args.length === 2 ? Number(args[1]) : null;
  assert.ok(
    args.length === 0 || (Number.isSafeInteger(pid) && pid > 0),
    "Expected only optional --after-exit <pid>",
  );
  assertMacArm();
  if (pid !== null && !(await waitForExit(pid, 30_000)))
    process.stderr.write(`Process ${pid} is still running.\n`);
  const active = await current();
  assert.ok(active, "There is no active Nix release to install");
  // A busy lock or failed copy must still bring the app back after a restart.
  let bundle = appBundle(active.outputPath);
  try {
    await withOperationLock(join(DATA_ROOT, "operation.lock"), async () => {
      bundle = await syncDesktopApp(active.outputPath, {
        waitForQuitMs: pid === null ? 0 : 30_000,
      });
    });
  } catch (error) {
    if (pid === null) throw error;
    process.stderr.write(`${error.message}\n`);
  }
  if (pid !== null) launchDesktopApp(bundle);
  else process.stdout.write(`${bundle}\n`);
}

export async function runPaseoNixUpdate(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  const commands = [
    "check",
    "stage",
    "activate",
    "status",
    "migrate",
    "rollback",
    "reactivate-high-water",
    "legacy-status",
    "legacy-rollback",
    "legacy-reactivate-high-water",
  ];
  if (command === "help" || command === "--help") {
    process.stdout.write(
      `Usage: paseo-nix-update <${commands.join("|")}> [--json]\n` +
        "       paseo-nix-update install-app [--after-exit <pid>]\n",
    );
    return;
  }
  if (command === "install-app") {
    await installApp(rest);
    return;
  }
  assert.ok(
    rest.length === 0 || (rest.length === 1 && rest[0] === "--json"),
    "Expected only optional --json",
  );
  assert.ok(commands.includes(command), "Unsupported updater command");
  assertMacArm();
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  const root = await lstat(DATA_ROOT);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), "Invalid updater state root");
  await withOperationLock(join(DATA_ROOT, "operation.lock"), async () => {
    if (command.startsWith("legacy-")) {
      assert.ok(
        !(await exists(join(STATE_ROOT, "profile-state.json"))) &&
          !(await exists(join(STATE_ROOT, "pending-activation.json"))),
        "Fork migration has started; use normal rollback/reactivate-high-water for recorded recovery",
      );
      await runLegacyRecovery(command.slice(7), rest.includes("--json"));
      return;
    }
    await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
    const stateRoot = await lstat(STATE_ROOT);
    assert.ok(stateRoot.isDirectory() && !stateRoot.isSymbolicLink(), "Invalid semver state root");
    await mkdir(join(STATE_ROOT, "receipts"), { recursive: true, mode: 0o700 });
    const adapters = {
      ...productionAdapters(),
      async assertNoLegacyJournal() {
        assert.ok(
          !(await exists(join(DATA_ROOT, "pending-activation.json"))),
          "A legacy activation journal requires explicit legacy-status recovery before fork updates",
        );
      },
      readStaged: () => readOptional(join(STATE_ROOT, "staged.json")),
      clearStaged: () => rm(join(STATE_ROOT, "staged.json"), { force: true }),
      loadReceipt,
      legacySnapshot: readLegacyRecoverySnapshot,
      latest: () => latestVerifiedRelease(),
      stage: stageRelease,
    };
    const result = await executeCommand(command, adapters);
    process.stdout.write(
      rest.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : `${result.active?.releaseTag ?? "No active fork release"}\n${result.message}\n`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPaseoNixUpdate().catch((error) => {
    const message = error instanceof Error ? error.message : "Paseo updater failed";
    if (process.argv.includes("--json"))
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
