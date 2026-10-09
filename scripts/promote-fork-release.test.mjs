import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDigestMatches,
  assertPromotionTagAvailable,
  extractExpectedZip,
  isPublishedPromotionRelease,
  parseLaneArtifactAttempt,
  validateCandidate,
  validateLaneFiles,
  validateReleaseMonotonicity,
  verifyReleaseManifestSignatureBytes,
} from "./promote-fork-release.mjs";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  serializePaseoReleaseManifest,
} from "../packages/protocol/src/release-manifest.ts";

const sha = (character) => character.repeat(64);
const sourceSha = (character) => character.repeat(40);
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function releaseManifest({
  releaseSequence = 200002,
  androidVersionCode = releaseSequence,
  source = "b",
  rollbackOf = null,
} = {}) {
  const revision = sourceSha(source);
  return {
    schemaVersion: 1,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    channel: "fork",
    releaseTag: `paseo-fork-v0.11.0-r${releaseSequence}-${revision}`,
    sourceSha: revision,
    runId: "12345",
    runAttempt: 1,
    releaseSequence,
    packageVersion: "0.11.0",
    promotionToolSha: sourceSha("c"),
    createdAt: "2026-10-09T17:00:00.000Z",
    macOS: {
      system: "aarch64-darwin",
      outputPath: "/nix/store/0123456789abcdfghijklmnpqrstuvwx-paseo-desktop-0.11.0",
      closureArchive: { name: "closure.tar", bytes: 100, sha256: sha("a") },
      closureManifest: { name: "closure-manifest.json", bytes: 200, sha256: sha("a") },
    },
    android: {
      abi: "arm64-v8a",
      packageId: "sh.paseo.iexalt",
      versionCode: androidVersionCode,
      signingCertificateSha256: sha("a"),
      apk: { name: "paseo.apk", bytes: 300, sha256: sha("a") },
      buildMetadata: { name: "android-metadata.json", bytes: 200, sha256: sha("a") },
    },
    rollbackOf,
  };
}

function rawPublicKey(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64url");
}

function signatureFor(manifest, privateKey) {
  const bytes = Buffer.from(serializePaseoReleaseManifest(manifest));
  return {
    bytes,
    signature: Buffer.from(`${sign(null, bytes, privateKey).toString("base64url")}\n`),
  };
}

test("detached Ed25519 manifest signature verifies and detects altered bytes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = releaseManifest();
  const signed = signatureFor(manifest, privateKey);

  assert.equal(
    verifyReleaseManifestSignatureBytes(signed.bytes, signed.signature, rawPublicKey(publicKey))
      .sourceSha,
    manifest.sourceSha,
  );
  assert.throws(
    () =>
      verifyReleaseManifestSignatureBytes(
        Buffer.from(signed.bytes.toString().replace('"bytes":100', '"bytes":101')),
        signed.signature,
        rawPublicKey(publicKey),
      ),
    /signature does not match/,
  );
});

test("detached signature rejects a different public key and malformed signature", () => {
  const signer = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const signed = signatureFor(releaseManifest(), signer.privateKey);

  assert.throws(
    () =>
      verifyReleaseManifestSignatureBytes(
        signed.bytes,
        signed.signature,
        rawPublicKey(other.publicKey),
      ),
    /signature does not match/,
  );
  assert.throws(
    () =>
      verifyReleaseManifestSignatureBytes(
        signed.bytes,
        Buffer.from("bad"),
        rawPublicKey(signer.publicKey),
      ),
    /signature is malformed/,
  );
});

test("promotion requires strictly increasing sequence and Android code", () => {
  const prior = releaseManifest({ releaseSequence: 200001, source: "d" });
  assert.doesNotThrow(() => validateReleaseMonotonicity(releaseManifest(), [prior]));
  assert.throws(
    () => validateReleaseMonotonicity(releaseManifest({ releaseSequence: 200001 }), [prior]),
    /must both exceed/,
  );
  assert.throws(
    () => validateReleaseMonotonicity(releaseManifest({ androidVersionCode: 200001 }), [prior]),
    /must both exceed/,
  );
});

test("rollback points only to a known, older signed release", () => {
  const prior = releaseManifest({ releaseSequence: 200001, source: "d" });
  const rollback = releaseManifest({
    rollbackOf: {
      releaseTag: prior.releaseTag,
      sourceSha: prior.sourceSha,
      releaseSequence: prior.releaseSequence,
      androidVersionCode: prior.android.versionCode,
    },
  });

  assert.doesNotThrow(() => validateReleaseMonotonicity(rollback, [prior], prior.releaseTag));
  assert.throws(
    () => validateReleaseMonotonicity(rollback, [], prior.releaseTag),
    /not a verified published release/,
  );
  assert.throws(
    () => validateReleaseMonotonicity(rollback, [prior]),
    /explicit known rollback target/,
  );
});

test("promotion rejects asset digest mismatch and existing tag or release", () => {
  assert.doesNotThrow(() => assertDigestMatches(sha("a"), sha("a"), "APK"));
  assert.throws(() => assertDigestMatches(sha("a"), sha("b"), "APK"), /digest does not match/);
  assert.doesNotThrow(() => assertPromotionTagAvailable(false, false));
  assert.throws(() => assertPromotionTagAvailable(true, false), /already exists/);
  assert.throws(() => assertPromotionTagAvailable(false, true), /already exists/);
});

test("promotion accepts a verified lane artifact from an earlier successful attempt", () => {
  assert.equal(parseLaneArtifactAttempt("1", 2, "macOS"), 1);
  assert.equal(parseLaneArtifactAttempt("2", 2, "Android"), 2);
  assert.throws(
    () => parseLaneArtifactAttempt("3", 2, "macOS"),
    /invalid for the selected workflow attempt/,
  );
  assert.throws(
    () => parseLaneArtifactAttempt("01", 2, "Android"),
    /invalid for the selected workflow attempt/,
  );
});

test("prior release inventory excludes probe seeds, drafts, and unrelated tags", () => {
  const release = {
    draft: false,
    prerelease: false,
    tag_name: `paseo-fork-v0.11.0-r200002-${sourceSha("b")}`,
  };
  assert.equal(isPublishedPromotionRelease(release), true);
  assert.equal(isPublishedPromotionRelease({ ...release, prerelease: true }), false);
  assert.equal(isPublishedPromotionRelease({ ...release, draft: true }), false);
  assert.equal(
    isPublishedPromotionRelease({ ...release, tag_name: "nix-closure-probe-seed" }),
    false,
  );
});

test("paired candidate and lane files match the producer metadata shapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-promotion-contract-"));
  try {
    const expected = { sourceSha: sourceSha("b"), runId: "12345", attempt: 2, sequence: 200002 };
    const outputPath = "/nix/store/0123456789abcdfghijklmnpqrstuvwx-paseo-desktop-0.11.0";
    const lockHash = sha("e");
    const apkBytes = Buffer.from("small signed APK fixture");
    const archiveBytes = Buffer.from("small signed Nix archive fixture");
    const androidHash = hashBytes(apkBytes);
    const androidMetadata = {
      sourceSha: expected.sourceSha,
      runId: expected.runId,
      runNumber: "456",
      runAttempt: "1",
      releaseSequence: String(expected.sequence),
      packageId: "sh.paseo.iexalt",
      versionCode: String(expected.sequence),
      abi: "arm64-v8a",
      signingRunId: expected.runId,
      signingRunAttempt: "1",
      signingCertificateSha256: "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459",
      apkSha256: androidHash,
    };
    const androidMetadataBytes = Buffer.from(`${JSON.stringify(androidMetadata)}\n`);
    const androidMetadataHash = hashBytes(androidMetadataBytes);
    const macManifest = {
      schemaVersion: 1,
      sourceSha: expected.sourceSha,
      releaseSequence: expected.sequence,
      lockHash,
      system: "aarch64-darwin",
      attr: "packages.aarch64-darwin.default",
      packageVersion: "0.11.0",
      buildVersion: String(expected.sequence),
      derivationPath: "/nix/store/example.drv",
      outputPath,
      provenance: "local-ci-build",
      nodeSeedProvenance: "local-built-dependency",
      nodeSeed: {
        provenance: "local-built-dependency",
        sourceSha: "119dda15072d5af0f4083a23eaf411587f621f95",
        sourceRevCount: 5787,
        lockHash: "2e8911706b05e02f12256848cd3c14482e88f99a65401cee3ded4aa761db3ee3",
        archive: {
          name: "paseo-nix-node-seed-fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6.tar",
          sha256: "fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6",
          bytes: "69248000",
        },
        manifest: {
          name: "paseo-nix-node-seed-manifest-e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6.json",
          sha256: "e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6",
        },
        keyId: "paseo-nix-seed-20261009-164633",
        signingKey: "paseo-nix-seed-20261009-164633:HKUIBntJ2BXdOwsTH8Z/ou1oO5sEXIUsU6ZiGuhWN54=",
        roots: [
          "/nix/store/3vd5kgvc7l4hcg5mlr21f09inywmfnd6-nodejs-slim-26.11.0",
          "/nix/store/w9a1j4q81r51fc2z2fgadh8z61ndyyay-nodejs-slim-26.11.0-dev",
        ],
      },
      closure: [{ path: outputPath, narHash: "sha256-example", narSize: 100 }],
    };
    const macManifestBytes = Buffer.from(`${JSON.stringify(macManifest)}\n`);
    const macManifestHash = hashBytes(macManifestBytes);
    const macArchiveHash = hashBytes(archiveBytes);
    const ids = { candidate: "10", macos: "11", android: "12" };
    const digests = { candidate: sha("a"), macos: sha("c"), android: sha("d") };
    const candidate = {
      schemaVersion: 1,
      status: "candidate",
      sourceSha: expected.sourceSha,
      releaseSequence: expected.sequence,
      runId: expected.runId,
      runAttempt: String(expected.attempt),
      android: {
        artifactName: `paseo-iexalt-${expected.sequence}-${expected.sourceSha}-attempt-1`,
        artifactId: ids.android,
        artifactDigest: digests.android,
        artifactRunAttempt: "1",
        apkSha256: androidHash,
        metadataSha256: androidMetadataHash,
        packageId: "sh.paseo.iexalt",
        versionCode: String(expected.sequence),
        signingCertificateSha256: androidMetadata.signingCertificateSha256,
      },
      macOS: {
        artifactName: `paseo-nix-closure-${expected.sourceSha}-${expected.sequence}-attempt-1`,
        artifactId: ids.macos,
        artifactDigest: digests.macos,
        artifactRunAttempt: "1",
        manifestSha256: macManifestHash,
        archiveSha256: macArchiveHash,
        lockHash,
        outputPath,
        manifestPath: "/nix/store/example-pinned-manifest.json",
        system: "aarch64-darwin",
        provenance: "local-ci-build",
        nodeSeedProvenance: "local-built-dependency",
      },
    };
    assert.doesNotThrow(() => validateCandidate(candidate, expected, ids, digests));
    assert.doesNotThrow(() =>
      validateCandidate(
        {
          ...candidate,
          android: { ...candidate.android, artifactDigest: `sha256:${digests.android}` },
          macOS: { ...candidate.macOS, artifactDigest: `sha256:${digests.macos}` },
        },
        expected,
        ids,
        digests,
      ),
    );
    assert.doesNotThrow(() =>
      validateCandidate(candidate, expected, ids, {
        android: `sha256:${digests.android}`,
        macos: `sha256:${digests.macos}`,
      }),
    );
    assert.throws(
      () =>
        validateCandidate(
          { ...candidate, android: { ...candidate.android, artifactDigest: "bad-digest" } },
          expected,
          ids,
          { ...digests, android: "bad-digest" },
        ),
      /artifact identity does not match/,
    );
    assert.equal(candidate.laneAttempts.android, 1);
    assert.equal(candidate.laneAttempts.macos, 1);
    assert.throws(
      () => validateCandidate({ ...candidate, sourceSha: sourceSha("f") }, expected, ids, digests),
      /selected run identity/,
    );
    assert.throws(
      () => validateCandidate({ ...candidate, macOS: undefined }, expected, ids, digests),
      /Candidate macOS lane must be a JSON object/,
    );
    assert.throws(
      () =>
        validateCandidate(
          { ...candidate, android: { ...candidate.android, artifactDigest: `sha256:${sha("f")}` } },
          expected,
          ids,
          digests,
        ),
      /artifact identity does not match/,
    );

    const paths = {
      androidApk: join(directory, "paseo.apk"),
      androidMetadata: join(directory, "android-metadata.json"),
      macArchive: join(directory, "closure.tar"),
      macManifest: join(directory, "manifest.json"),
    };
    await Promise.all([
      writeFile(paths.androidApk, apkBytes),
      writeFile(paths.androidMetadata, androidMetadataBytes),
      writeFile(paths.macArchive, archiveBytes),
      writeFile(paths.macManifest, macManifestBytes),
    ]);
    const files = await validateLaneFiles(paths, candidate, expected);
    assert.equal(files.packageVersion, macManifest.packageVersion);
    assert.equal(files.macManifest.nodeSeed.provenance, "local-built-dependency");
    await assert.rejects(
      validateLaneFiles(
        paths,
        { ...candidate, android: { ...candidate.android, apkSha256: sha("f") } },
        expected,
      ),
      /Android APK or signed build metadata differs/,
    );
    await assert.rejects(
      validateLaneFiles(
        paths,
        { ...candidate, macOS: { ...candidate.macOS, manifestSha256: sha("f") } },
        expected,
      ),
      /macOS closure archive or manifest differs/,
    );

    await assert.rejects(
      validateLaneFiles(paths, candidate, { ...expected, sourceSha: sourceSha("f") }),
      /Android APK or signed build metadata differs/,
    );
    await writeFile(paths.macManifest, `${JSON.stringify({ ...macManifest, closure: [] })}\n`);
    candidate.macOS.manifestSha256 = hashBytes(await readFile(paths.macManifest));
    await assert.rejects(
      validateLaneFiles(paths, candidate, expected),
      /macOS closure archive or manifest differs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android artifact accepts only its exact unextracted APK signature sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-promotion-zip-contract-"));
  const required = ["paseo-iexalt-fork-200005.apk", "build-metadata.json", "SHA256SUMS"];
  const optional = ["paseo-iexalt-fork-200005.apk.idsig"];

  async function makeZip(label, names) {
    const source = join(directory, `${label}-source`);
    const archive = join(directory, `${label}.zip`);
    await mkdir(source);
    await Promise.all(names.map((name) => writeFile(join(source, name), `fixture:${name}`)));
    execFileSync("zip", ["-q", archive, ...names], { cwd: source });
    return archive;
  }

  try {
    const exactSidecarZip = await makeZip("exact-sidecar", [...required, ...optional]);
    const extracted = join(directory, "extracted");
    await mkdir(extracted);
    await extractExpectedZip(exactSidecarZip, extracted, required, optional);
    for (const name of required) {
      assert.equal(await readFile(join(extracted, name), "utf8"), `fixture:${name}`);
    }
    await assert.rejects(readFile(join(extracted, optional[0])), { code: "ENOENT" });

    const missingRequiredZip = await makeZip("missing-required", required.slice(0, -1));
    await assert.rejects(
      extractExpectedZip(missingRequiredZip, join(directory, "missing-output"), required, optional),
      /unexpected or unsafe entries/,
    );

    const unexpectedSidecarZip = await makeZip("unexpected-sidecar", [
      ...required,
      "paseo-iexalt-fork-200005.apk.other.idsig",
    ]);
    await assert.rejects(
      extractExpectedZip(
        unexpectedSidecarZip,
        join(directory, "unexpected-output"),
        required,
        optional,
      ),
      /unexpected or unsafe entries/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
