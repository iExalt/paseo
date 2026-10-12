import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forkReleaseManifestFixture } from "./test-fixtures/fork-release-manifest.ts";
import { FORK_RELEASE_LINEAGE } from "../packages/protocol/src/release-manifest-v2.ts";
import {
  emptyState,
  validateState,
  assertCurrent,
  planTransaction,
  recoverTransaction,
} from "./paseo-nix-update-state.mjs";
import {
  executeCommand,
  verifyReleaseManifestBytes,
  validateNixClosureManifest,
  chooseHighestVerifiedStableRelease,
  macArtifact,
} from "./paseo-nix-update.mjs";

const legacy = {
  lineage: "legacy-v1",
  generation: 4,
  identity: `${"d".repeat(40)}-200008`,
  outputPath: `/nix/store/${"d".repeat(32)}-paseo-desktop-0.11.0`,
};
function target(version = "0.1.0", generation = null) {
  return {
    lineage: FORK_RELEASE_LINEAGE,
    generation,
    identity: `${"b".repeat(40)}-v${version}`,
    outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-${version}`,
    version,
  };
}
function migratingState() {
  return { ...emptyState(), current: legacy, legacyRecovery: legacy };
}
const actual = (entry) => entry && { generation: entry.generation, outputPath: entry.outputPath };

test("semver transaction reducer distinguishes source, target, rollback and conflicting profile movement", () => {
  const initial = migratingState();
  const journal = planTransaction(initial, "migrate", target());
  assert.equal(recoverTransaction(journal, actual(legacy)).switched, false);
  const state = recoverTransaction(journal, actual(target("0.1.0", 5))).state;
  assert.equal(state.highWater.version, "0.1.0");
  assert.deepEqual(state.legacyRecovery, legacy);
  assert.throws(() => recoverTransaction(journal, actual(target("0.2.0", 6))), /unexpected output/);
  assert.throws(() => planTransaction(state, "activate", target("0.0.9")), /high-water/);
  const rollback = planTransaction(state, "rollback", legacy);
  const rolledBack = recoverTransaction(rollback, actual(legacy)).state;
  assert.equal(rolledBack.highWater.version, "0.1.0");
  assert.throws(
    () => recoverTransaction(rollback, { ...actual(legacy), generation: 99 }),
    /different retained/,
  );
  const reactivate = planTransaction(rolledBack, "reactivate-high-water", state.highWater);
  assert.deepEqual(recoverTransaction(reactivate, actual(state.highWater)).state, state);
  assert.throws(() => assertCurrent(state, actual(legacy)), /outside the updater/);
  assert.throws(() => validateState({ ...state, highWater: null }), /highest activated/);
  assert.throws(
    () => validateState({ ...state, releaseSequence: 200008 }),
    /Unsupported updater fields/,
  );
});

test("V2 verification binds exact signed bytes and producer closure metadata without accepting V1", async () => {
  const manifest = forkReleaseManifestFixture();
  const artifact = macArtifact(manifest);
  const closure = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      kind: "paseo-verification-candidate",
      sourceSha: manifest.sourceSha,
      forkVersion: manifest.version,
      system: artifact.system,
      outputPath: artifact.outputPath,
      provenance: "local-ci-build",
      closure: [{ path: artifact.outputPath, narHash: `sha256-${"A".repeat(43)}=`, narSize: 100 }],
    }),
  );
  artifact.closureManifest.bytes = closure.length;
  artifact.closureManifest.sha256 = createHash("sha256").update(closure).digest("hex");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = Buffer.from(sign(null, bytes, keys.privateKey).toString("base64url"));
  assert.deepEqual(verifyReleaseManifestBytes(bytes, signature, publicKey), manifest);
  assert.throws(
    () => verifyReleaseManifestBytes(Buffer.from(JSON.stringify(manifest)), signature, publicKey),
    /signature/,
  );
  const old = Buffer.from(JSON.stringify({ schemaVersion: 1, releaseSequence: 200008 }));
  assert.throws(() =>
    verifyReleaseManifestBytes(
      old,
      Buffer.from(sign(null, old, keys.privateKey).toString("base64url")),
      publicKey,
    ),
  );
  assert.equal(validateNixClosureManifest(closure, manifest).forkVersion, "0.1.0");
  assert.throws(() =>
    validateNixClosureManifest(Buffer.concat([closure, Buffer.from(" ")]), manifest),
  );
  const selected = await chooseHighestVerifiedStableRelease(
    [
      { tag_name: "paseo-fork-v0.11.0-r200008-" + "d".repeat(40) },
      { tag_name: "v0.1.1" },
      { tag_name: "paseo-v0.1.10" },
      { tag_name: "paseo-v0.1.2" },
      { tag_name: "paseo-v1.0.0", draft: true },
    ],
    async (release) =>
      release.tag_name === "paseo-v0.1.10" ? null : { manifest: { version: "0.1.2" } },
  );
  assert.equal(selected.manifest.version, "0.1.2");
});

test("command orchestration preserves legacy bytes, retries interrupted migration, and retains high-water across recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-semver-commands-"));
  const files = {
    state: join(root, "state.json"),
    journal: join(root, "journal.json"),
    staged: join(root, "staged.json"),
  };
  const legacyFile = join(root, "legacy-receipt.json");
  const legacyBytes = '{"schemaVersion":1,"releaseSequence":200008}\n';
  await writeFile(legacyFile, legacyBytes);
  const read = async (file) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  let selected = actual(legacy);
  let failWrite = true;
  let failSelect = true;
  let failClear = false;
  let legacyPending = true;
  let candidateVersion = "0.1.0";
  let selections = 0;
  let lastGeneration = 4;
  const adapters = {
    current: async () => selected,
    readState: () => read(files.state),
    readJournal: () => read(files.journal),
    writeState: async (state) => {
      if (failWrite) throw new Error("state write interrupted");
      await writeFile(files.state, JSON.stringify(state));
    },
    writeJournal: (journal) => writeFile(files.journal, JSON.stringify(journal)),
    clearJournal: async () => {
      if (failClear) {
        failClear = false;
        throw new Error("journal cleanup interrupted");
      }
      await rm(files.journal, { force: true });
    },
    async verifyTarget(value) {
      assert.ok(value.identity);
    },
    async selectTarget(value) {
      if (failSelect) throw new Error("profile switch interrupted");
      selections++;
      selected = actual({ ...value, generation: value.generation ?? ++lastGeneration });
    },
    async assertNoLegacyJournal() {
      assert.equal(legacyPending, false, "legacy pending journal");
    },
    legacySnapshot: async () => ({ target: legacy }),
    readStaged: () => read(files.staged),
    clearStaged: () => rm(files.staged, { force: true }),
    loadReceipt: async (value) => {
      assert.ok(value.identity);
    },
    latest: async () => ({ manifest: forkReleaseManifestFixture(candidateVersion) }),
    stage: async () => {
      const value = target(candidateVersion);
      await writeFile(files.staged, JSON.stringify(value));
      return value;
    },
  };
  try {
    await assert.rejects(executeCommand("migrate", adapters), /legacy pending/);
    assert.equal(selections, 0);
    legacyPending = false;
    await assert.rejects(executeCommand("check", adapters), /manual migration/);
    await assert.rejects(executeCommand("migrate", adapters), /profile switch interrupted/);
    await assert.rejects(executeCommand("status", adapters), /manual migration/);
    assert.equal(
      await read(files.journal),
      null,
      "Unchanged-source recovery clears only its own journal",
    );
    assert.equal(await read(files.state), null);
    failSelect = false;
    await assert.rejects(executeCommand("migrate", adapters), /state write interrupted/);
    assert.equal(selections, 1);
    assert.equal((await read(files.journal)).action, "migrate");
    failWrite = false;
    failClear = true;
    await assert.rejects(executeCommand("migrate", adapters), /journal cleanup interrupted/);
    assert.equal((await read(files.state)).highWater.version, "0.1.0");
    const migrated = await executeCommand("migrate", adapters);
    assert.equal(migrated.highWaterVersion, "0.1.0");
    assert.equal(selections, 1, "Recovery must not repeat the profile switch");
    assert.equal(await read(files.journal), null);
    assert.equal((await executeCommand("migrate", adapters)).active.version, "0.1.0");
    const rolledBack = await executeCommand("rollback", adapters);
    assert.equal(rolledBack.active, null);
    assert.equal(rolledBack.highWaterVersion, "0.1.0");
    await assert.rejects(executeCommand("stage", adapters), /high-water/);
    assert.equal((await executeCommand("reactivate-high-water", adapters)).active.version, "0.1.0");
    candidateVersion = "0.1.1";
    assert.equal((await executeCommand("stage", adapters)).staged.version, "0.1.1");
    assert.equal(
      (await read(files.state)).highWater.version,
      "0.1.0",
      "Staging must not advance installed state",
    );
    selected = { ...selected, generation: 99 };
    await assert.rejects(executeCommand("activate", adapters), /outside the updater/);
    selected = actual(target("0.1.0", 5));
    const upgraded = await executeCommand("activate", adapters);
    assert.equal(upgraded.active.version, "0.1.1");
    assert.equal(upgraded.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 6);
    const previousFork = await executeCommand("rollback", adapters);
    assert.equal(previousFork.active.version, "0.1.0");
    assert.equal(previousFork.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 5);
    const reactivated = await executeCommand("reactivate-high-water", adapters);
    assert.equal(reactivated.active.version, "0.1.1");
    assert.equal(reactivated.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 6);
    assert.equal(await readFile(legacyFile, "utf8"), legacyBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
