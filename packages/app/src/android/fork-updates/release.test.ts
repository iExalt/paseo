import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  forkReleaseManifestFixture as manifestFor,
  forkReleaseManifestV3Fixture as manifestV3For,
} from "../../../../../scripts/test-fixtures/fork-release-manifest";
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
    expect(releaseVersionFromTag("v0.1.1")).toBeNull();
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

  it("selects a v3 release when it is the only published release", async () => {
    const keyPair = nacl.sign.keyPair();
    const base64Url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestV3For("0.2.0")));
    const signatureText = base64Url(nacl.sign.detached(manifestBytes, keyPair.secretKey));
    const only = releaseFor("0.2.0");
    const result = await findHighestVerifiedForkRelease([only], async (release) =>
      verifyReleaseBinding(
        release,
        verifySignedManifest(manifestBytes, signatureText, base64Url(keyPair.publicKey)),
      ),
    );
    expect(result.release).toBe(only);
    expect(result.verified.manifest.schemaVersion).toBe(3);
    expect(result.verified.android.versionCode).toBe(200000 + 2000);
    expect(result.verified.apkUrl).toBe(
      "https://github.com/iExalt/paseo/releases/download/paseo-v0.2.0/paseo.apk",
    );
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
