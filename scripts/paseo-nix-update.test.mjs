import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serializePaseoReleaseManifest } from "../packages/protocol/src/release-manifest.ts";
import {
  assertReceiptIdentity,
  assertAboveHighWater,
  assertNativeReactivationReceipts,
  assertNativeReactivationState,
  applyMetadataIntent,
  chooseHighestVerifiedStableRelease,
  commitRecoveredNativeIntent,
  extractNixCacheTar,
  finishPendingActivation,
  highestReleaseIdentity,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  parseProfileGenerations,
  recoverNativeIntent,
  selectHighWaterReactivationTarget,
  selectLegacyReceiptIdentity,
  selectMappedGeneration,
  validateNixClosureManifest,
  verifyReleaseManifestBytes,
  withOperationLock,
} from "./paseo-nix-update.mjs";

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-nix-update-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await makeTemporaryTreeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeTemporaryTreeWritable(path) {
  const entry = await lstat(path).catch(() => null);
  if (!entry || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(path, (entry.mode & 0o7777) | 0o700);
    for (const child of await readdir(path)) {
      await makeTemporaryTreeWritable(join(path, child));
    }
    return;
  }
  await chmod(path, (entry.mode & 0o7777) | 0o600);
}

function signedManifest(sequence = 42) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sourceSha = "a".repeat(40);
  const manifest = {
    schemaVersion: 1,
    keyId: "paseo-release-manifest-1",
    channel: "fork",
    releaseTag: `paseo-fork-v1.2.3-r${sequence}-${sourceSha}`,
    sourceSha,
    runId: "12345",
    runAttempt: 1,
    releaseSequence: sequence,
    packageVersion: "1.2.3",
    promotionToolSha: "b".repeat(40),
    createdAt: "2026-10-09T00:00:00.000Z",
    macOS: {
      system: "aarch64-darwin",
      outputPath: `/nix/store/${"c".repeat(32)}-paseo-desktop-1.2.3`,
      closureArchive: { name: "cache.tar", bytes: 1024, sha256: "d".repeat(64) },
      closureManifest: { name: "cache.json", bytes: 100, sha256: "e".repeat(64) },
    },
    android: {
      abi: "arm64-v8a",
      packageId: "sh.paseo.iexalt",
      versionCode: sequence,
      signingCertificateSha256: "f".repeat(64),
      apk: { name: "app.apk", bytes: 1000, sha256: "1".repeat(64) },
      buildMetadata: { name: "build.json", bytes: 100, sha256: "2".repeat(64) },
    },
    rollbackOf: null,
  };
  const bytes = Buffer.from(serializePaseoReleaseManifest(manifest));
  const signature = Buffer.from(sign(null, bytes, privateKey).toString("base64url"));
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    manifest,
    bytes,
    signature,
    publicKey: spki.subarray(spki.length - 32).toString("base64url"),
  };
}

function nativeReactivationFixture() {
  const outputB = `/nix/store/${"a".repeat(32)}-paseo-desktop-0.11.0`;
  const outputC = `/nix/store/${"b".repeat(32)}-paseo-desktop-0.11.0`;
  const identityB = `${"a".repeat(40)}-200006`;
  const identityC = `${"b".repeat(40)}-200007`;
  const receiptB = {
    manifest: {
      sourceSha: "a".repeat(40),
      releaseSequence: 200006,
      macOS: { outputPath: outputB },
    },
  };
  const receiptC = {
    manifest: {
      sourceSha: "b".repeat(40),
      releaseSequence: 200007,
      macOS: { outputPath: outputC },
    },
  };
  const state = {
    schemaVersion: 1,
    highWaterIdentity: identityC,
    highWaterSequence: 200007,
    generations: [
      { generation: 1, outputPath: outputB, identities: [identityB] },
      { generation: 2, outputPath: outputC, identities: [identityC] },
    ],
  };
  const pending = {
    schemaVersion: 1,
    kind: "native-reactivate",
    fromGeneration: 1,
    fromOutputPath: outputB,
    fromIdentity: identityB,
    targetGeneration: 2,
    targetIdentity: identityC,
    targetOutputPath: outputC,
    highWaterIdentity: identityC,
    highWaterSequence: 200007,
  };
  return { outputB, outputC, identityB, identityC, receiptB, receiptC, state, pending };
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarFile(name, contents, type = "0") {
  const bytes = Buffer.from(contents);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, bytes.length, type), bytes, padding]);
}

function runNix(args, { allowFailure = false, input, store } = {}) {
  const commandArgs = store && store !== "default" ? ["--store", store, ...args] : args;
  const result = spawnSync("nix", commandArgs, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Nix fixture command failed (${result.status}): ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

function fixtureLocalStore(parent, name) {
  return `local?root=${join(parent, `${name}-root`)}&state=${join(parent, `${name}-state`)}&require-sigs=false`;
}

describe("Paseo Nix updater verification", () => {
  it("encodes Application Support paths in the local Nix cache source URL", () => {
    const args = localCacheCopyArgs(
      "/Users/test/Library/Application Support/Paseo/nix-update/download/cache",
      `/nix/store/${"c".repeat(32)}-paseo-desktop-1.2.3`,
    );
    assert.equal(
      args[2],
      "file:///Users/test/Library/Application%20Support/Paseo/nix-update/download/cache",
    );
    assert.equal(args[0], "copy");
    assert.equal(args[1], "--from");

    const signatureArgs = localCacheCopySignaturesArgs(
      "/Users/test/Library/Application Support/Paseo/nix-update/download/cache",
      `/nix/store/${"c".repeat(32)}-paseo-desktop-1.2.3`,
    );
    assert.deepEqual(signatureArgs.slice(0, 4), [
      "store",
      "copy-sigs",
      "--substituter",
      "file:///Users/test/Library/Application%20Support/Paseo/nix-update/download/cache",
    ]);
    assert.ok(signatureArgs.includes("--recursive"));
  });

  it(
    "copies only the pinned cache signature onto an already-present input-addressed path",
    { skip: process.env.PASEO_NIX_SIGNATURE_FIXTURE !== "1" },
    async () => {
      const directory = await mkdtemp(
        join(
          process.platform === "darwin" ? "/private/tmp" : tmpdir(),
          "paseo-nix-copy-sigs-test-",
        ),
      );
      temporaryDirectories.push(directory);
      const sourceStore = fixtureLocalStore(directory, "source");
      const destinationStore = fixtureLocalStore(directory, "destination");
      const cache = join(directory, "cache");
      const unsignedCache = join(directory, "unsigned-cache");
      const oldKeyPath = join(directory, "old.key");
      const newKeyPath = join(directory, "new.key");
      await mkdir(cache);

      const oldKey = runNix(["key", "generate-secret", "--key-name", "fixture-old"]).stdout;
      const newKey = runNix(["key", "generate-secret", "--key-name", "fixture-new"]).stdout;
      await writeFile(oldKeyPath, `${oldKey}\n`, { mode: 0o600 });
      await writeFile(newKeyPath, `${newKey}\n`, { mode: 0o600 });
      await chmod(oldKeyPath, 0o600);
      await chmod(newKeyPath, 0o600);
      const oldPublic = runNix(["key", "convert-secret-to-public"], { input: oldKey }).stdout;
      const newPublic = runNix(["key", "convert-secret-to-public"], { input: newKey }).stdout;

      const fixtureRoot = process.env.PASEO_NIX_SIGNATURE_FIXTURE_ROOT;
      assert.ok(fixtureRoot, "the real isolated fixture needs an already-imported closure root");
      const fixtureStore = process.env.PASEO_NIX_SIGNATURE_FIXTURE_STORE;
      assert.ok(fixtureStore, "the real isolated fixture requires the imported verification store");
      const closure = JSON.parse(
        runNix(["path-info", "--json", "--recursive", fixtureRoot], { store: fixtureStore }).stdout,
      );
      const candidates = Object.entries(closure)
        .filter(([, info]) => info.ca === null && info.references.length === 0)
        .sort((left, right) => left[1].narSize - right[1].narSize);
      assert.ok(candidates.length > 0, "the imported closure must contain an input-addressed leaf");
      const [outputPath] = candidates[0];

      runNix(
        [
          "copy",
          "--to",
          sourceStore,
          "--option",
          "builders",
          "",
          "--option",
          "substituters",
          "",
          outputPath,
        ],
        { store: fixtureStore },
      );
      const sourceInfo = JSON.parse(
        runNix(["path-info", "--json", outputPath], { store: sourceStore }).stdout,
      )[outputPath];
      assert.equal(sourceInfo.ca, null, "the fixture must exercise input-addressed paths");

      runNix(["store", "sign", "--key-file", newKeyPath, outputPath], { store: sourceStore });
      runNix(
        [
          "copy",
          "--to",
          `file://${cache}?secret-key=${newKeyPath}`,
          "--option",
          "builders",
          "",
          "--option",
          "substituters",
          "",
          outputPath,
        ],
        { store: sourceStore },
      );
      const hashPart = outputPath.split("/").at(-1).slice(0, 32);
      const narinfoPath = join(cache, `${hashPart}.narinfo`);
      const narinfo = await readFile(narinfoPath, "utf8");
      assert.match(narinfo, /^Sig: fixture-new:/m);
      const onlyNewSignature = narinfo
        .split("\n")
        .filter((line) => !line.startsWith("Sig:") || line.startsWith("Sig: fixture-new:"))
        .join("\n");
      await writeFile(narinfoPath, onlyNewSignature);
      await cp(cache, unsignedCache, { recursive: true });
      await writeFile(
        join(unsignedCache, `${hashPart}.narinfo`),
        onlyNewSignature
          .split("\n")
          .filter((line) => !line.startsWith("Sig:"))
          .join("\n"),
      );
      const signedFiles = await readdir(cache);
      assert.equal(signedFiles.filter((name) => name.endsWith(".narinfo")).length, 1);

      runNix([
        "copy",
        "--from",
        `file://${unsignedCache}`,
        "--to",
        destinationStore,
        "--option",
        "builders",
        "",
        "--option",
        "substituters",
        "",
        "--option",
        "require-sigs",
        "false",
        outputPath,
      ]);
      const unsigned = JSON.parse(
        runNix(["path-info", "--json", outputPath], { store: destinationStore }).stdout,
      )[outputPath];
      assert.equal(
        unsigned.ca,
        null,
        "the fixture must exercise signature-required input-addressed paths",
      );
      assert.deepEqual(
        unsigned.signatures,
        [],
        "an unsigned archive import must leave the path unsigned",
      );

      runNix([
        "store",
        "copy-sigs",
        "--store",
        destinationStore,
        "--substituter",
        `file://${cache}`,
        "--recursive",
        "--option",
        "builders",
        "",
        "--option",
        "substituters",
        "",
        "--option",
        "require-sigs",
        "true",
        "--option",
        "trusted-public-keys",
        newPublic,
        outputPath,
      ]);
      const after = JSON.parse(
        runNix(["path-info", "--json", outputPath], { store: destinationStore }).stdout,
      )[outputPath];
      assert.deepEqual(
        after.signatures.map((signature) => signature.split(":")[0]),
        ["fixture-new"],
      );

      const verifyArgs = [
        "store",
        "verify",
        "--store",
        destinationStore,
        "--sigs-needed",
        "1",
        "--no-contents",
        "--option",
        "require-sigs",
        "true",
        "--option",
        "trusted-public-keys",
      ];
      const rejected = runNix([...verifyArgs, oldPublic, outputPath], { allowFailure: true });
      assert.notEqual(rejected.status, 0, "a different key must not verify the copied signature");
      assert.match(rejected.stderr, /signature|trusted|public key|key/i);
      assert.equal(runNix([...verifyArgs, newPublic, outputPath]).status, 0);
    },
  );

  it("verifies detached Ed25519 bytes before trusting the release schema", () => {
    const fixture = signedManifest();
    assert.deepEqual(
      verifyReleaseManifestBytes(fixture.bytes, fixture.signature, fixture.publicKey),
      fixture.manifest,
    );
    assert.throws(
      () =>
        verifyReleaseManifestBytes(
          Buffer.concat([fixture.bytes, Buffer.from(" ")]),
          fixture.signature,
          fixture.publicKey,
        ),
      /signature|manifest/i,
    );
    assert.throws(
      () => verifyReleaseManifestBytes(fixture.bytes, fixture.signature, "z".repeat(43)),
      /signature/i,
    );
    assert.throws(
      () => verifyReleaseManifestBytes(Buffer.from("{"), fixture.signature, fixture.publicKey),
      /signature does not match/i,
    );
  });

  it("serializes updater commands and releases its lock after a command failure", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "operation.lock");
    let enteredOperation;
    let finishOperation;
    const entered = new Promise((resolve) => {
      enteredOperation = resolve;
    });
    const blocked = new Promise((resolve) => {
      finishOperation = resolve;
    });
    const first = withOperationLock(lockPath, async () => {
      enteredOperation();
      await blocked;
      throw new Error("simulated command failure");
    });
    await entered;
    await assert.rejects(
      withOperationLock(lockPath, async () => {}),
      /Another Paseo updater command/,
    );
    finishOperation();
    await assert.rejects(first, /simulated command failure/);
    await assert.rejects(access(lockPath), { code: "ENOENT" });
    await withOperationLock(lockPath, async () => {});
  });

  it("accepts the closure manifest shape emitted by the CI producer", () => {
    const { manifest } = signedManifest();
    const closureManifest = {
      schemaVersion: 1,
      sourceSha: manifest.sourceSha,
      releaseSequence: manifest.releaseSequence,
      lockHash: "a".repeat(64),
      system: "aarch64-darwin",
      attr: ".#packages.aarch64-darwin.desktop",
      packageVersion: manifest.packageVersion,
      buildVersion: "1.2.3",
      derivationPath: `/nix/store/${"b".repeat(32)}-paseo-desktop.drv`,
      outputPath: manifest.macOS.outputPath,
      provenance: "local-ci-build",
      nodeSeedProvenance: "local-built-dependency",
      nodeSeed: {
        provenance: "local-built-dependency",
        sourceSha: "c".repeat(40),
        sourceRevCount: 100,
        lockHash: "d".repeat(64),
        archive: { name: "seed.tar", sha256: "e".repeat(64), bytes: 128 },
        manifest: { name: "seed.json", sha256: "f".repeat(64) },
        keyId: "paseo-nix-seed-20261009-164633",
        signingKey: "public-key-pin",
        roots: ["/nix/store/example-nodejs"],
      },
      closure: [
        {
          path: manifest.macOS.outputPath,
          narHash: `sha256-${"A".repeat(43)}=`,
          narSize: 4096,
        },
      ],
    };
    assert.deepEqual(
      validateNixClosureManifest(Buffer.from(JSON.stringify(closureManifest)), manifest),
      closureManifest,
    );
  });

  it("rejects a valid signed receipt stored under another release identity", () => {
    const { manifest } = signedManifest(42);
    const identity = `${manifest.sourceSha}-${manifest.releaseSequence}`;
    assert.doesNotThrow(() => assertReceiptIdentity(`/receipts/${identity}`, manifest));
    assert.throws(
      () => assertReceiptIdentity(`/receipts/${"b".repeat(40)}-43`, manifest),
      /differs from its directory name/i,
    );
  });

  it("selects the highest verified stable sequence and ignores unsigned higher tags", async () => {
    const release = (sequence) => ({
      tag_name: `paseo-fork-v1.2.3-r${sequence}-${"a".repeat(40)}`,
      draft: false,
      prerelease: false,
    });
    const selected = await chooseHighestVerifiedStableRelease(
      [release(12), release(100), release(42), { ...release(200), prerelease: true }],
      async (candidate) => {
        if (candidate.tag_name.includes("-r100-")) return null;
        const sequence = Number(candidate.tag_name.match(/-r(\d+)-/)[1]);
        return { release: candidate, manifest: { releaseSequence: sequence } };
      },
    );
    assert.equal(selected.manifest.releaseSequence, 42);
  });

  it("keeps replay protection above a rollback and recovers pending activation state after a storage failure", async () => {
    const lower = { releaseSequence: 42 };
    const higher = { releaseSequence: 43 };
    assert.doesNotThrow(() => assertAboveHighWater(higher, { manifest: lower }));
    assert.throws(() => assertAboveHighWater(lower, { manifest: higher }), /not above/i);

    const pending = { identity: "a".repeat(40) + "-43", outputPath: "/nix/store/output" };
    let pendingCleared = false;
    let storageFailed = true;
    const adapters = {
      async loadReceipt() {
        return { manifest: { macOS: { outputPath: pending.outputPath } } };
      },
      async activeOutputPath() {
        return pending.outputPath;
      },
      async writeHighWater() {
        if (storageFailed) throw new Error("simulated durable-state write failure");
      },
      async clearPending() {
        pendingCleared = true;
      },
    };
    await assert.rejects(
      finishPendingActivation(pending, adapters),
      /simulated durable-state write failure/,
    );
    assert.equal(pendingCleared, false);
    storageFailed = false;
    await finishPendingActivation(pending, adapters);
    assert.equal(pendingCleared, true);
  });

  it("selects only the exact retained generation for high-water reactivation", () => {
    const fixture = nativeReactivationFixture();
    const { outputB, outputC, identityC, receiptB, receiptC, state } = fixture;
    const current = { generation: 1, outputPath: outputB, receipt: receiptB };
    const retained = [
      { generation: 1, outputPath: outputB, current: true },
      { generation: 2, outputPath: outputC, current: false },
    ];
    const withoutTarget = retained.filter((entry) => entry.generation !== 2);

    assert.deepEqual(selectHighWaterReactivationTarget(state, current, retained, receiptC), {
      generation: 2,
      identity: identityC,
      outputPath: outputC,
      sequence: 200007,
    });
    assert.equal(
      selectHighWaterReactivationTarget(
        { ...state, generations: [...state.generations] },
        { generation: 2, outputPath: outputC, receipt: receiptC },
        [
          { generation: 1, outputPath: outputB, current: false },
          { generation: 2, outputPath: outputC, current: true },
        ],
        receiptC,
      ),
      null,
    );
    assert.throws(
      () => selectHighWaterReactivationTarget(state, current, withoutTarget, receiptC),
      /exact retained Nix generation/i,
    );
    assert.throws(
      () =>
        selectHighWaterReactivationTarget(state, current, retained, {
          manifest: { ...receiptC.manifest, sourceSha: "c".repeat(40) },
        }),
      /does not match its signed receipt/i,
    );
    assert.throws(
      () =>
        selectHighWaterReactivationTarget(state, current, retained, {
          manifest: { ...receiptC.manifest, releaseSequence: 200008 },
        }),
      /does not match its signed receipt/i,
    );
    assert.throws(
      () =>
        selectHighWaterReactivationTarget(
          {
            ...state,
            generations: [...state.generations, { ...state.generations[1], generation: 3 }],
          },
          current,
          retained,
          receiptC,
        ),
      /missing or ambiguous retained generation/i,
    );
    assert.throws(
      () =>
        selectHighWaterReactivationTarget(
          state,
          { ...current, outputPath: outputC },
          retained,
          receiptC,
        ),
      /not below|shares the active Nix output/i,
    );
  });

  it("keeps reactivation bound to the exact high-water receipt and both generation mappings", () => {
    const { state, pending, receiptC, identityB } = nativeReactivationFixture();
    const wrongTargetIdentityState = {
      ...state,
      generations: state.generations.map((entry) => {
        if (entry.generation !== 2) return entry;
        return Object.assign({}, entry, { identities: [identityB] });
      }),
    };

    assert.doesNotThrow(() => assertNativeReactivationState(state, pending, receiptC.manifest));
    assert.throws(
      () =>
        assertNativeReactivationState(
          { ...state, highWaterSequence: 200008 },
          pending,
          receiptC.manifest,
        ),
      /unchanged signed high-water/i,
    );
    assert.throws(
      () => assertNativeReactivationState(wrongTargetIdentityState, pending, receiptC.manifest),
      /retained signed generation mapping/i,
    );
  });

  it("tracks same-root release identity changes without changing the Nix generation", () => {
    const outputPath = `/nix/store/${"c".repeat(32)}-paseo-desktop-1.2.3`;
    const identityB = `${"a".repeat(40)}-42`;
    const identityC = `${"b".repeat(40)}-43`;
    const initial = {
      schemaVersion: 1,
      highWaterIdentity: identityB,
      highWaterSequence: 42,
      legacyHighWaterIdentity: identityB,
      generations: [{ generation: 7, outputPath, identities: [identityB] }],
    };
    const activation = {
      kind: "metadata-activate",
      fromGeneration: 7,
      fromIdentity: identityB,
      targetIdentity: identityC,
      targetOutputPath: outputPath,
    };

    // A crash before the atomic state rename leaves the original identity intact.
    assert.equal(initial.generations[0].identities.at(-1), identityB);
    const activeC = applyMetadataIntent(initial, activation, 43);
    assert.equal(activeC.generations[0].generation, 7);
    assert.deepEqual(activeC.generations[0].identities, [identityB, identityC]);
    assert.equal(activeC.highWaterIdentity, identityC);
    assert.equal(activeC.highWaterSequence, 43);
    // A crash after the rename makes recovery idempotently clear the journal.
    assert.equal(applyMetadataIntent(activeC, activation, 43), activeC);

    const rollback = {
      kind: "metadata-rollback",
      fromGeneration: 7,
      fromIdentity: identityC,
      targetIdentity: identityB,
      targetOutputPath: outputPath,
    };
    const activeB = applyMetadataIntent(activeC, rollback, 43);
    assert.deepEqual(activeB.generations[0].identities, [identityB]);
    assert.equal(activeB.highWaterIdentity, identityC);
    assert.equal(activeB.highWaterSequence, 43);
    assert.equal(applyMetadataIntent(activeB, rollback, 43), activeB);
  });

  it("recovers native activation by signed output and native rollback/reactivation by exact generation", () => {
    const pending = {
      kind: "native-activate",
      fromGeneration: 7,
      fromOutputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-1`,
      targetOutputPath: `/nix/store/${"b".repeat(32)}-paseo-desktop-2`,
    };
    assert.equal(
      recoverNativeIntent(pending, { generation: 7, outputPath: pending.fromOutputPath }),
      "unchanged",
    );
    assert.equal(
      recoverNativeIntent(pending, { generation: 8, outputPath: pending.targetOutputPath }),
      "switched",
    );
    const rollback = { ...pending, kind: "native-rollback", targetGeneration: 6 };
    assert.equal(
      recoverNativeIntent(rollback, { generation: 6, outputPath: pending.targetOutputPath }),
      "switched",
    );
    const reactivation = {
      ...rollback,
      kind: "native-reactivate",
      fromGeneration: 6,
      fromOutputPath: pending.targetOutputPath,
      targetGeneration: 8,
    };
    assert.equal(
      recoverNativeIntent(reactivation, {
        generation: 6,
        outputPath: reactivation.fromOutputPath,
      }),
      "unchanged",
    );
    assert.equal(
      recoverNativeIntent(reactivation, {
        generation: 8,
        outputPath: reactivation.targetOutputPath,
      }),
      "switched",
    );
    assert.throws(
      () =>
        recoverNativeIntent(reactivation, {
          generation: 9,
          outputPath: reactivation.targetOutputPath,
        }),
      /manual recovery/i,
    );
    assert.equal(
      recoverNativeIntent({ ...pending, fromGeneration: null, fromOutputPath: null }, null),
      "unchanged",
    );
    assert.throws(
      () =>
        recoverNativeIntent(pending, {
          generation: 9,
          outputPath: `/nix/store/${"c".repeat(32)}-paseo-desktop-3`,
        }),
      /manual recovery/i,
    );
  });

  it("recovers retained high-water reactivation without lowering state and retries journal cleanup", async () => {
    const { outputB, outputC, identityC, state, pending, receiptB, receiptC } =
      nativeReactivationFixture();
    const target = receiptC;
    const wrongTargetOutputState = {
      ...state,
      generations: state.generations.map((entry) => {
        if (entry.generation !== 2) return entry;
        return Object.assign({}, entry, { outputPath: outputB });
      }),
    };

    // A crash before setProfile leaves B current; retry can validate the same retained target.
    const unchanged = { generation: 1, outputPath: outputB };
    assert.equal(recoverNativeIntent(pending, unchanged), "unchanged");
    assert.doesNotThrow(() => assertNativeReactivationState(state, pending, target.manifest));
    assert.doesNotThrow(() => assertNativeReactivationReceipts(pending, receiptB, target));
    assert.throws(
      () =>
        assertNativeReactivationReceipts(pending, receiptB, {
          manifest: { ...target.manifest, sourceSha: "c".repeat(40) },
        }),
      /do not prove a lower signed source/i,
    );
    assert.throws(() => {
      const equalSequenceManifest = {
        ...receiptB.manifest,
        sourceSha: "c".repeat(40),
        releaseSequence: 200007,
      };
      assertNativeReactivationReceipts(
        { ...pending, fromIdentity: `${"c".repeat(40)}-200007` },
        { manifest: equalSequenceManifest },
        target,
      );
    }, /do not prove a lower signed source/i);
    assert.deepEqual(state.generations[1], {
      generation: 2,
      outputPath: outputC,
      identities: [identityC],
    });

    // A crash after setProfile accepts only the exact retained C generation and keeps high-water.
    const switched = { generation: 2, outputPath: outputC };
    assert.equal(recoverNativeIntent(pending, switched), "switched");
    let pendingExists = true;
    let failClear = true;
    const adapters = {
      async loadState() {
        return state;
      },
      async commitState(next) {
        assert.equal(next, state);
      },
      async clearPending() {
        if (failClear) {
          failClear = false;
          throw new Error("simulated journal cleanup failure");
        }
        pendingExists = false;
      },
    };
    await assert.rejects(
      commitRecoveredNativeIntent(pending, switched, target, adapters),
      /journal cleanup failure/,
    );
    assert.equal(pendingExists, true);
    assert.equal(state.highWaterIdentity, identityC);
    assert.equal(state.highWaterSequence, 200007);
    await commitRecoveredNativeIntent(pending, switched, target, adapters);
    assert.equal(pendingExists, false);
    assert.equal(state.highWaterIdentity, identityC);
    assert.equal(state.highWaterSequence, 200007);

    assert.throws(
      () =>
        assertNativeReactivationState(
          { ...state, highWaterSequence: 200006 },
          pending,
          target.manifest,
        ),
      /unchanged signed high-water/i,
    );
    assert.throws(
      () => assertNativeReactivationState(wrongTargetOutputState, pending, target.manifest),
      /retained signed generation mapping/i,
    );
  });

  it(
    "rejects staged reactivation before invoking Nix or changing the profile",
    {
      skip: process.platform !== "darwin" || process.arch !== "arm64",
    },
    async () => {
      const home = await temporaryDirectory();
      const dataRoot = join(home, "Library", "Application Support", "Paseo", "nix-update");
      const fakeBin = join(home, "bin");
      const calls = join(home, "nix-calls");
      await mkdir(dataRoot, { recursive: true });
      await mkdir(fakeBin);
      await writeFile(join(dataRoot, "staged.json"), "{}\n");
      for (const executable of ["nix", "nix-env"]) {
        const path = join(fakeBin, executable);
        await writeFile(
          path,
          '#!/bin/sh\nprintf \'%s\\n\' "$0 $*" >> "$PASEO_NIX_CALLS"\nexit 97\n',
        );
        await chmod(path, 0o755);
      }

      const script = fileURLToPath(new URL("./paseo-nix-update.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [script, "reactivate-high-water", "--json"], {
        encoding: "utf8",
        env: { HOME: home, PATH: fakeBin, PASEO_NIX_CALLS: calls },
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /another release is staged/i);
      await assert.rejects(access(calls));
    },
  );

  it("commits a reused Nix generation once and retries cleanup after atomic-state success", async () => {
    const outputA = `/nix/store/${"a".repeat(32)}-paseo-desktop-a`;
    const outputB = `/nix/store/${"b".repeat(32)}-paseo-desktop-b`;
    const identityB = `${"b".repeat(40)}-20`;
    const identityC = `${"c".repeat(40)}-21`;
    const target = { manifest: { releaseSequence: 21 } };
    const pending = {
      kind: "native-activate",
      fromGeneration: 7,
      fromOutputPath: outputA,
      fromIdentity: `${"a".repeat(40)}-19`,
      targetIdentity: identityC,
      targetOutputPath: outputB,
    };
    const current = { generation: 8, outputPath: outputB };
    let state = {
      schemaVersion: 1,
      highWaterIdentity: identityB,
      highWaterSequence: 20,
      generations: [
        { generation: 7, outputPath: outputA, identities: [`${"a".repeat(40)}-19`] },
        { generation: 8, outputPath: outputB, identities: [identityB] },
      ],
    };
    let pendingExists = true;
    let failCleanup = true;
    const adapters = {
      async loadState() {
        return state;
      },
      async commitState(next) {
        state = next;
      },
      async clearPending() {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("simulated journal cleanup failure");
        }
        pendingExists = false;
      },
    };

    await assert.rejects(
      commitRecoveredNativeIntent(pending, current, target, adapters),
      /journal cleanup failure/,
    );
    assert.equal(pendingExists, true);
    assert.equal(state.highWaterIdentity, identityC);
    assert.equal(state.highWaterSequence, 21);
    assert.deepEqual(state.generations[1], {
      generation: 8,
      outputPath: outputB,
      identities: [identityB, identityC],
    });
    assert.equal(state.generations.length, 2);

    await commitRecoveredNativeIntent(pending, current, target, adapters);
    assert.equal(pendingExists, false);
    assert.equal(state.highWaterIdentity, identityC);
    assert.equal(state.highWaterSequence, 21);
    assert.equal(state.generations.length, 2);
    assert.deepEqual(state.generations[1].identities, [identityB, identityC]);
  });

  it("resolves rollback receipts by generation and rejects ambiguous legacy roots", () => {
    const rootA = `/nix/store/${"a".repeat(32)}-paseo-desktop-a`;
    const rootB = `/nix/store/${"b".repeat(32)}-paseo-desktop-b`;
    const idA = `${"a".repeat(40)}-41`;
    const idB = `${"b".repeat(40)}-42`;
    const state = {
      generations: [
        { generation: 8, outputPath: rootB, identities: [idB] },
        { generation: 7, outputPath: rootA, identities: [idA] },
      ],
    };
    assert.equal(selectMappedGeneration(state, 7, rootA).identities.at(-1), idA);
    assert.throws(() => selectMappedGeneration(state, 7, rootB), /exact signed release mapping/i);
    assert.equal(selectLegacyReceiptIdentity([{ identity: idA, outputPath: rootA }], rootA), idA);
    assert.equal(
      selectLegacyReceiptIdentity(
        [
          { identity: idA, outputPath: rootA },
          { identity: idB, outputPath: rootA },
        ],
        rootA,
        idB,
      ),
      idB,
    );
    assert.throws(
      () =>
        selectLegacyReceiptIdentity(
          [
            { identity: idA, outputPath: rootA },
            { identity: idB, outputPath: rootA },
          ],
          rootA,
        ),
      /refusing to guess/i,
    );
    assert.deepEqual(
      highestReleaseIdentity([
        { identity: idA, sequence: 41 },
        { identity: idB, sequence: 42 },
      ]),
      { identity: idB, sequence: 42 },
    );
    assert.throws(
      () =>
        highestReleaseIdentity([
          { identity: idA, sequence: 42 },
          { identity: idB, sequence: 42 },
        ]),
      /share the highest activated sequence/i,
    );
  });

  it("parses current Nix generation output without inferring identity from output order", () => {
    assert.deepEqual(
      parseProfileGenerations(
        "   3   2026-10-08 14:15:16\n *  4   2026-10-09 09:10:11 (current)\n",
      ),
      [
        { generation: 3, current: false },
        { generation: 4, current: true },
      ],
    );
  });

  it("extracts regular cache members, ignores validated AppleDouble sidecars, and rejects unsafe types/paths", async () => {
    const directory = await temporaryDirectory();
    const archive = join(directory, "cache.tar");
    const end = Buffer.alloc(1024);
    await writeFile(
      archive,
      Buffer.concat([
        tarFile("./cache.narinfo", "signed narinfo"),
        tarFile("./._cache.narinfo", "metadata"),
        end,
      ]),
    );
    const destination = join(directory, "cache");
    assert.deepEqual(await extractNixCacheTar(archive, destination), {
      files: 1,
      extractedBytes: 14,
    });
    assert.equal(await readFile(join(destination, "cache.narinfo"), "utf8"), "signed narinfo");

    const traversalArchive = join(directory, "traversal.tar");
    await writeFile(traversalArchive, Buffer.concat([tarFile("../outside", "bad"), end]));
    await assert.rejects(
      extractNixCacheTar(traversalArchive, join(directory, "traversal")),
      /unsafe|escapes/i,
    );

    const linkArchive = join(directory, "link.tar");
    await writeFile(linkArchive, Buffer.concat([tarFile("cache-link", "", "2"), end]));
    await assert.rejects(
      extractNixCacheTar(linkArchive, join(directory, "link")),
      /unsupported member type/i,
    );
  });
});
