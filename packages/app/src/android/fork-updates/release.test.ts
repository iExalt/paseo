import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { approvedAndroidArtifact } from "./release";
import {
  findHighestVerifiedForkRelease,
  isForkAndroidUpdaterEnabled,
  isNewerThanInstalled,
  releaseVersionFromTag,
  verifyReleaseBinding,
  verifySignedManifest,
  type GitHubRelease,
} from "./release";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";

function releaseFor(version: string, overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  const manifest = manifestFor(version);
  return {
    tag_name: manifest.releaseTag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "paseo-release-manifest.json", size: 1024 },
      { name: "paseo-release-manifest.sig", size: 86 },
      {
        name: approvedAndroidArtifact(manifest).name,
        size: approvedAndroidArtifact(manifest).bytes,
      },
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

  it("accepts only canonical promoted stable tags and checks semver monotonicity", () => {
    expect(releaseVersionFromTag(releaseFor("0.1.2").tag_name)).toBe("0.1.2");
    expect(releaseVersionFromTag("nix-closure-probe-seed-20261009")).toBeNull();
    expect(releaseVersionFromTag(`paseo-fork-v0.11.0-r0-${sourceSha}`)).toBeNull();
    const update = verifyReleaseBinding(releaseFor("0.1.2"), manifestFor("0.1.2"));
    expect(isNewerThanInstalled(update, "0.1.1", "0.1.0")).toBe(true);
    expect(isNewerThanInstalled(update, "0.1.2", "0.1.0")).toBe(false);
    expect(isNewerThanInstalled(update, "0.1.1", "0.1.2")).toBe(false);
  });

  it("uses the highest signed stable semver instead of trusting a higher tag", async () => {
    const valid = releaseFor("0.1.1");
    const higherUnsigned = releaseFor("0.1.2", { assets: [] });
    const result = await findHighestVerifiedForkRelease(
      [valid, higherUnsigned, releaseFor("1.0.0", { prerelease: true })],
      async (release) => (release.tag_name === valid.tag_name ? manifestFor("0.1.1") : null),
    );
    expect(result.release.tag_name).toBe(valid.tag_name);
    expect(result.verified.version).toBe("0.1.1");
  });

  it("verifies detached bytes before accepting the schema and release binding", () => {
    const keyPair = nacl.sign.keyPair();
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestFor("0.1.2")));
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
    expect(verifyReleaseBinding(releaseFor("0.1.2"), verified).manifest.version).toBe("0.1.2");
    expect(() =>
      verifySignedManifest(new Uint8Array([...manifestBytes, 0]), signatureText, publicKeyText),
    ).toThrow(/signature/i);
    expect(() => verifySignedManifest(manifestBytes, signatureText, btoa("wrong-key"))).toThrow(
      /signature or public key/i,
    );
    const legacyBytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, releaseSequence: 200008 }),
    );
    const legacySignature = nacl.sign.detached(legacyBytes, keyPair.secretKey);
    const legacySignatureText = btoa(String.fromCharCode(...legacySignature))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(() => verifySignedManifest(legacyBytes, legacySignatureText, publicKeyText)).toThrow(
      /manifest is invalid/i,
    );
  });

  it("offers the gzip sidecar only when exactly one plausibly sized copy exists", () => {
    const manifest = manifestFor("0.1.2");
    const apk = approvedAndroidArtifact(manifest);
    const withSidecars = (...sizes: number[]) =>
      verifyReleaseBinding(
        releaseFor("0.1.2", {
          assets: [
            ...releaseFor("0.1.2").assets,
            ...sizes.map((size) => ({ name: `${apk.name}.gz`, size })),
          ],
        }),
        manifest,
      ).gzipApkBytes;
    expect(withSidecars(apk.bytes - 1)).toBe(apk.bytes - 1);
    expect(withSidecars()).toBeUndefined();
    expect(withSidecars(1, 1)).toBeUndefined();
    for (const size of [0, apk.bytes, apk.bytes + 1]) expect(withSidecars(size)).toBeUndefined();
  });

  it("offers each plausibly sized delta sidecar by its base version", () => {
    const manifest = manifestFor("0.1.2");
    const apk = approvedAndroidArtifact(manifest);
    const deltas = verifyReleaseBinding(
      releaseFor("0.1.2", {
        assets: [
          ...releaseFor("0.1.2").assets,
          { name: `${apk.name}.delta-from-0.1.1.zst`, size: 7 },
          { name: `${apk.name}.delta-from-0.1.0.zst`, size: apk.bytes - 1 },
          { name: `${apk.name}.delta-from-0.0.9.zst`, size: apk.bytes },
          { name: `${apk.name}.delta-from-0.0.8.zst`, size: 0 },
          { name: `${apk.name}.delta-from-01.0.0.zst`, size: 7 },
          { name: `${apk.name}.delta-from-0.1.zst`, size: 7 },
          { name: `${apk.name}.delta-from-0.1.0.zst.part`, size: 7 },
          { name: `other-${apk.name}.delta-from-0.1.0.zst`, size: 7 },
        ],
      }),
      manifest,
    ).apkDeltaBytes;
    expect(deltas).toEqual({ "0.1.1": 7, "0.1.0": apk.bytes - 1 });
    expect(verifyReleaseBinding(releaseFor("0.1.2"), manifest).apkDeltaBytes).toBeUndefined();
  });

  it("rejects mismatched assets, package identity, and nonstable releases", () => {
    const manifest = manifestFor("0.1.2");
    expect(() => verifyReleaseBinding(releaseFor("0.1.2", { prerelease: true }), manifest)).toThrow(
      /stable/i,
    );
    expect(() =>
      verifyReleaseBinding(
        releaseFor("0.1.2", {
          assets: [{ name: approvedAndroidArtifact(manifest).name, size: 99 }],
        }),
        manifest,
      ),
    ).toThrow(/APK asset/i);
    expect(() =>
      verifyReleaseBinding(releaseFor("0.1.2"), {
        ...manifest,
        lineage: "legacy" as never,
      }),
    ).toThrow(/lineage/i);
  });
});
