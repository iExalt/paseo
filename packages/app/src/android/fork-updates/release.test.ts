import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import type { PaseoReleaseManifest } from "@getpaseo/protocol/release-manifest";
import {
  findHighestVerifiedForkRelease,
  isForkAndroidUpdaterEnabled,
  isNewerThanInstalled,
  releaseSequenceFromTag,
  verifyReleaseBinding,
  verifySignedManifest,
  type GitHubRelease,
} from "./release";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";

function manifestFor(sequence: number): PaseoReleaseManifest {
  const packageVersion = "0.11.0";
  return {
    schemaVersion: 1,
    keyId: "paseo-release-manifest-1",
    channel: "fork",
    releaseTag: `paseo-fork-v${packageVersion}-r${sequence}-${sourceSha}`,
    sourceSha,
    runId: "1234567890",
    runAttempt: 1,
    releaseSequence: sequence,
    packageVersion,
    promotionToolSha: sourceSha,
    createdAt: "2026-10-09T17:00:00.000Z",
    macOS: {
      system: "aarch64-darwin",
      outputPath: "/nix/store/0123456789abcdef0123456789abcdef-paseo-desktop-0.11.0",
      closureArchive: { name: "mac.tar", bytes: 1, sha256: "a".repeat(64) },
      closureManifest: { name: "mac.json", bytes: 1, sha256: "b".repeat(64) },
    },
    android: {
      abi: "arm64-v8a",
      packageId: "sh.paseo.iexalt",
      versionCode: sequence,
      signingCertificateSha256: "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459",
      apk: { name: "Paseo-fork.apk", bytes: 100, sha256: "c".repeat(64) },
      buildMetadata: { name: "android.json", bytes: 1, sha256: "d".repeat(64) },
    },
    rollbackOf: null,
  };
}

function releaseFor(sequence: number, overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  const manifest = manifestFor(sequence);
  return {
    tag_name: manifest.releaseTag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "paseo-release-manifest.json", size: 1024 },
      { name: "paseo-release-manifest.sig", size: 86 },
      { name: manifest.android.apk.name, size: manifest.android.apk.bytes },
    ],
    ...overrides,
  };
}

describe("fork release verification", () => {
  it("exposes the updater only to fork Android builds with the native bridge", () => {
    expect(isForkAndroidUpdaterEnabled("android", true, true)).toBe(true);
    expect(isForkAndroidUpdaterEnabled("android", false, true)).toBe(false);
    expect(isForkAndroidUpdaterEnabled("ios", true, true)).toBe(false);
    expect(isForkAndroidUpdaterEnabled("android", true, false)).toBe(false);
  });

  it("accepts only canonical promoted stable tags and checks sequence monotonicity", () => {
    expect(releaseSequenceFromTag(releaseFor(42).tag_name)).toBe(42);
    expect(releaseSequenceFromTag("nix-closure-probe-seed-20261009")).toBeNull();
    expect(releaseSequenceFromTag(`paseo-fork-v0.11.0-r0-${sourceSha}`)).toBeNull();
    const update = verifyReleaseBinding(releaseFor(42), manifestFor(42));
    expect(isNewerThanInstalled(update, 41, 40)).toBe(true);
    expect(isNewerThanInstalled(update, 42, 40)).toBe(false);
    expect(isNewerThanInstalled(update, 41, 42)).toBe(false);
  });

  it("uses the highest signed stable sequence instead of trusting a higher tag", async () => {
    const valid = releaseFor(41);
    const higherUnsigned = releaseFor(42, { assets: [] });
    const result = await findHighestVerifiedForkRelease(
      [valid, higherUnsigned, releaseFor(100, { prerelease: true })],
      async (release) => (release.tag_name === valid.tag_name ? manifestFor(41) : null),
    );
    expect(result.release.tag_name).toBe(valid.tag_name);
    expect(result.verified.releaseSequence).toBe(41);
  });

  it("verifies detached bytes before accepting the schema and release binding", () => {
    const keyPair = nacl.sign.keyPair();
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestFor(42)));
    const signature = nacl.sign.detached(manifestBytes, keyPair.secretKey);
    const signatureText = btoa(String.fromCharCode(...signature))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const publicKeyText = btoa(String.fromCharCode(...keyPair.publicKey))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const verified = verifySignedManifest(manifestBytes, signatureText, publicKeyText);
    expect(verifyReleaseBinding(releaseFor(42), verified).manifest.releaseSequence).toBe(42);
    expect(() =>
      verifySignedManifest(new Uint8Array([...manifestBytes, 0]), signatureText, publicKeyText),
    ).toThrow(/signature/i);
    expect(() => verifySignedManifest(manifestBytes, signatureText, btoa("wrong-key"))).toThrow(
      /signature or public key/i,
    );
  });

  it("rejects mismatched assets, package identity, and nonstable releases", () => {
    const manifest = manifestFor(42);
    expect(() => verifyReleaseBinding(releaseFor(42, { prerelease: true }), manifest)).toThrow(
      /stable/i,
    );
    expect(() =>
      verifyReleaseBinding(
        releaseFor(42, { assets: [{ name: manifest.android.apk.name, size: 99 }] }),
        manifest,
      ),
    ).toThrow(/APK asset/i);
    expect(() =>
      verifyReleaseBinding(releaseFor(42), {
        ...manifest,
        android: { ...manifest.android, packageId: "sh.paseo" as "sh.paseo.iexalt" },
      }),
    ).toThrow(/approved Paseo fork/i);
  });
});
