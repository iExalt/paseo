import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assetNames,
  changelogSection,
  describeAsset,
  releaseManifestBytes,
  signManifest,
} from "../.github/scripts/release-manifest.mjs";
import { FORK_ANDROID_CERTIFICATE_SHA256 } from "../packages/protocol/src/release-manifest-v2.ts";
import { verifyReleaseManifestBytes } from "./paseo-nix-update.mjs";

const version = "0.2.0";
const names = assetNames(version);
const release = (overrides = {}) => ({
  version,
  sourceSha: "a".repeat(40),
  upstreamBase: "b".repeat(40),
  mac: {
    archive: describeAsset(names.macArchive, Buffer.from("tar")),
    closureManifest: describeAsset(names.macClosure, Buffer.from("{}")),
    outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-${version}`,
  },
  android: {
    apk: describeAsset(names.apk, Buffer.from("apk")),
    versionCode: 202000,
    signingCertificateSha256: FORK_ANDROID_CERTIFICATE_SHA256,
    ...overrides.android,
  },
});

test("builds a schema v3 manifest with exactly the macOS Nix and Android APK cells", () => {
  const manifest = JSON.parse(releaseManifestBytes(release()));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.releaseTag, "paseo-v0.2.0");
  assert.deepEqual(
    manifest.artifacts.map(({ platform, arch, kind }) => `${platform}/${arch}/${kind}`).sort(),
    ["android/arm64/apk", "macos/arm64/nix-desktop"],
  );
});

test("rejects a cell the protocol validator refuses", () => {
  assert.throws(() =>
    releaseManifestBytes(release({ android: { signingCertificateSha256: "c".repeat(64) } })),
  );
});

test("signs the exact bytes so the client verifier accepts them and only them", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = publicKey.export({ format: "jwk" }).x;
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const bytes = releaseManifestBytes(release());
  const signature = signManifest(bytes, pem, pin);
  assert.match(signature.toString(), /^[A-Za-z0-9_-]{86}$/);
  assert.equal(verifyReleaseManifestBytes(bytes, signature, pin).version, version);
  const tampered = Buffer.from(bytes.toString().replace("0.2.0", "0.2.1"));
  assert.throws(() => verifyReleaseManifestBytes(tampered, signature, pin));
  assert.throws(() => signManifest(bytes, pem), /pinned public key/);
});

test("release notes are the changelog section of the released version", () => {
  const changelog =
    "# Changelog\n\n## [0.2.0](https://x) (2026-10-20)\n\n### Features\n\n* a\n\n## [0.1.4](https://x) (2026-10-15)\n\n* b\n";
  assert.equal(changelogSection(changelog, "0.2.0"), "### Features\n\n* a\n");
  assert.throws(() => changelogSection(changelog, "0.2.1"));
});
