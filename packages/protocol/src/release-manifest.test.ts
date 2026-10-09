import { describe, expect, it } from "vitest";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  serializePaseoReleaseManifest,
  validatePaseoReleaseManifest,
  type PaseoReleaseManifest,
} from "./release-manifest.js";

const digest = "a".repeat(64);
const sourceSha = "b".repeat(40);

function manifest(): PaseoReleaseManifest {
  return {
    schemaVersion: 1,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    channel: "fork",
    releaseTag: `paseo-fork-v0.11.0-r200001-${sourceSha}`,
    sourceSha,
    runId: "123456789",
    runAttempt: 1,
    releaseSequence: 200001,
    packageVersion: "0.11.0",
    promotionToolSha: "c".repeat(40),
    createdAt: "2026-10-09T17:00:00.000Z",
    macOS: {
      system: "aarch64-darwin",
      outputPath: "/nix/store/0123456789abcdfghijklmnpqrstuvwx-paseo-desktop-0.11.0",
      closureArchive: { name: "closure.tar", bytes: 160, sha256: digest },
      closureManifest: { name: "closure-manifest.json", bytes: 400, sha256: digest },
    },
    android: {
      abi: "arm64-v8a",
      packageId: "sh.paseo.iexalt",
      versionCode: 200001,
      signingCertificateSha256: digest,
      apk: { name: "paseo.apk", bytes: 700, sha256: digest },
      buildMetadata: { name: "android-metadata.json", bytes: 400, sha256: digest },
    },
    rollbackOf: null,
  };
}

describe("Paseo release manifest contract", () => {
  it("accepts a complete paired release and deterministically serializes it", () => {
    const value = manifest();
    expect(() => validatePaseoReleaseManifest(value)).not.toThrow();
    const serialized = serializePaseoReleaseManifest(value);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toBe(
      serializePaseoReleaseManifest({ ...value, android: { ...value.android } }),
    );
  });

  it("rejects a missing platform and malformed asset hashes", () => {
    const missingPlatform = { ...manifest(), android: undefined };
    expect(() => validatePaseoReleaseManifest(missingPlatform)).toThrow(
      /android must be an object/,
    );

    const malformedHash = manifest();
    malformedHash.android.apk.sha256 = "not-a-sha256";
    expect(() => validatePaseoReleaseManifest(malformedHash)).toThrow(/sha256 is invalid/);
  });

  it("requires version code and release tag to bind the paired identity", () => {
    const mismatchedCode = manifest();
    mismatchedCode.android.versionCode += 1;
    expect(() => validatePaseoReleaseManifest(mismatchedCode)).toThrow(
      /match the paired release sequence/,
    );

    const mismatchedTag = manifest();
    mismatchedTag.releaseTag = `paseo-fork-v0.11.0-r200002-${sourceSha}`;
    expect(() => validatePaseoReleaseManifest(mismatchedTag)).toThrow(/releaseTag does not match/);
  });

  it("rejects rollback metadata that is not strictly older", () => {
    const value = manifest();
    value.rollbackOf = {
      releaseTag: `paseo-fork-v0.11.0-r200000-${"d".repeat(40)}`,
      sourceSha: "d".repeat(40),
      releaseSequence: 200000,
      androidVersionCode: 200001,
    };
    expect(() => validatePaseoReleaseManifest(value)).toThrow(/strictly older release identity/);
  });
});
