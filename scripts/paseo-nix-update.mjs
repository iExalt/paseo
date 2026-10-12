#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  assertApiAsset,
  assetFromRelease,
  releaseAssetBytes,
  downloadAsset,
  fetchHttps,
  assertFreeSpace,
  writeJson,
  profileGenerations,
  setProfile,
  extractNixCacheTar,
  nix,
  nixOptions,
  isNixClosureEntry,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  readLegacyRecoverySnapshot,
  loadLegacyReceipt,
  verifyLegacyImportedClosure,
  runLegacyRecovery,
} from "./paseo-nix-update-legacy.mjs";
import {
  emptyState,
  validateState,
  assertCurrent,
  validateTarget,
  executeTransaction,
  reconcileTransaction,
} from "./paseo-nix-update-state.mjs";

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

function releaseVersion(release) {
  return release.draft || release.prerelease ? null : forkVersionFromTag(release.tag_name);
}

async function verifiedRelease(release) {
  const [{ bytes }, { bytes: signatureBytes }] = await Promise.all([
    releaseAssetBytes(release, RELEASE_MANIFEST_ASSET),
    releaseAssetBytes(release, RELEASE_SIGNATURE_ASSET),
  ]);
  const manifest = verifyReleaseManifestBytes(bytes, signatureBytes);
  assert.equal(manifest.releaseTag, release.tag_name);
  const artifact = macArtifact(manifest);
  for (const entry of [artifact, artifact.closureManifest]) {
    const asset = assetFromRelease(release, entry.name);
    assert.equal(asset.size, entry.bytes);
  }
  return { release, manifest, manifestBytes: bytes, signatureBytes };
}

export async function chooseHighestVerifiedStableRelease(releases, verify = verifiedRelease) {
  const candidates = releases
    .map((release) => ({ release, version: releaseVersion(release) }))
    .filter((entry) => entry.version !== null)
    .sort((a, b) => compareForkVersions(b.version, a.version));
  const versions = new Set();
  for (const candidate of candidates) {
    assert.ok(!versions.has(candidate.version), "Duplicate published fork version");
    versions.add(candidate.version);
  }
  for (const { release } of candidates) {
    try {
      const verified = await verify(release);
      if (verified) return verified;
    } catch {
      /* Invalid or unavailable candidate cannot authorize an update. */
    }
  }
  throw new Error("No valid signed stable fork release was found.");
}

async function listReleases() {
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetchHttps(
      `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
      { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    );
    assert.ok(response.ok, `GitHub releases API returned ${response.status}`);
    const batch = await response.json();
    assert.ok(Array.isArray(batch), "Invalid release list");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Fork release lookup exceeded its page limit.");
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

async function stageRelease(verified) {
  const artifact = macArtifact(verified.manifest);
  const archive = assetFromRelease(verified.release, artifact.name);
  assertApiAsset(archive, verified.manifest.releaseTag);
  const { bytes: nixManifestBytes } = await releaseAssetBytes(
    verified.release,
    artifact.closureManifest.name,
  );
  const closure = validateNixClosureManifest(nixManifestBytes, verified.manifest);
  await assertFreeSpace(
    artifact.bytes,
    closure.closure.reduce((sum, entry) => sum + entry.narSize, 0),
    STATE_ROOT,
  );
  const directory = await mkdtemp(join(STATE_ROOT, "download-"));
  try {
    const file = join(directory, artifact.name);
    await downloadAsset(archive, file, {
      expectedBytes: artifact.bytes,
      expectedSha256: artifact.sha256,
      maxBytes: artifact.bytes,
    });
    const cache = join(directory, "cache");
    await extractNixCacheTar(file, cache);
    nix(localCacheCopyArgs(cache, artifact.outputPath), { quiet: true });
    nix(localCacheCopySignaturesArgs(cache, artifact.outputPath), { quiet: true });
    const receipt = { ...verified, nixManifestBytes };
    await verifyClosure(receipt);
    await persistReceipt(receipt);
    setProfile(STAGING_PROFILE, artifact.outputPath, { quiet: true });
    const target = targetFor(verified.manifest);
    await writeJson(join(STATE_ROOT, "staged.json"), target);
    return target;
  } finally {
    await rm(directory, { recursive: true, force: true });
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

function commandResult(command, state, staged, latest) {
  return {
    ok: true,
    action: command,
    active: summary(state.current),
    staged: summary(staged),
    ...(latest ? { latest: summary(latest) } : {}),
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
  if (!completedReplay && ["check", "stage", "migrate"].includes(command)) {
    const candidate = await adapters.latest();
    latest = targetFor(candidate.manifest);
    if (command !== "check") {
      assert.ok(
        !state.highWater || compareForkVersions(latest.version, state.highWater.version) > 0,
        "Candidate does not exceed the fork semver high-water mark",
      );
      staged = await adapters.stage(candidate);
    }
  }
  if (!completedReplay)
    ({ state, staged } = await executeMutation(command, state, staged, adapters));
  return commandResult(command, state, staged, latest);
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
  assert.ok(
    rest.length === 0 || (rest.length === 1 && rest[0] === "--json"),
    "Expected only optional --json",
  );
  if (command === "help" || command === "--help") {
    process.stdout.write(`Usage: paseo-nix-update <${commands.join("|")}> [--json]\n`);
    return;
  }
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
      latest: async () => chooseHighestVerifiedStableRelease(await listReleases()),
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
