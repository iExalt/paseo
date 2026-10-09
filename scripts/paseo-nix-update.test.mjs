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
import { serializePaseoReleaseManifest } from "../packages/protocol/src/release-manifest.ts";
import {
  assertAboveHighWater,
  chooseHighestVerifiedStableRelease,
  extractNixCacheTar,
  finishPendingActivation,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
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
