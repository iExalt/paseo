// Builds, signs and verifies the signed release manifest for release.yml.
//   node release-manifest.mjs build <assets dir>   writes paseo-release-manifest.{json,sig}
//   node release-manifest.mjs notes <version>      prints the CHANGELOG.fork.md section
// build reads VERSION, SOURCE_SHA, UPSTREAM_BASE, MAC_OUTPUT_PATH, APK_VERSION_CODE,
// APK_CERT_SHA256 and PASEO_RELEASE_MANIFEST_PRIVATE_KEY from the environment.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { forkReleaseTag } from "../../packages/protocol/src/fork-version.ts";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
} from "../../packages/protocol/src/release-manifest.ts";
import {
  FORK_RELEASE_LINEAGE,
  FORK_RELEASE_REPOSITORY,
  serializeForkReleaseManifest,
} from "../../packages/protocol/src/release-manifest-v2.ts";
import {
  validateNixArtifactClosure,
  verifyReleaseManifestBytes,
} from "../../scripts/paseo-nix-update.mjs";

export const MANIFEST_ASSET = "paseo-release-manifest.json";
export const SIGNATURE_ASSET = "paseo-release-manifest.sig";

export const assetNames = (version) => ({
  macArchive: `paseo-${version}-macos-arm64-nix-desktop.tar`,
  macClosure: `paseo-${version}-macos-arm64-nix-desktop.json`,
  apk: `paseo-${version}-android-arm64.apk`,
});

export function describeAsset(name, bytes) {
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Returns the canonical manifest bytes; throws unless the protocol validator accepts them. */
export function releaseManifestBytes({ version, sourceSha, upstreamBase, mac, android }) {
  const manifest = {
    schemaVersion: 3,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    repository: FORK_RELEASE_REPOSITORY,
    lineage: FORK_RELEASE_LINEAGE,
    version,
    sourceSha,
    upstreamBase,
    releaseTag: forkReleaseTag(version),
    artifacts: [
      {
        platform: "macos",
        arch: "arm64",
        kind: "nix-desktop",
        ...mac.archive,
        system: "aarch64-darwin",
        outputPath: mac.outputPath,
        closureManifest: mac.closureManifest,
      },
      {
        platform: "android",
        arch: "arm64",
        kind: "apk",
        ...android.apk,
        abi: "arm64-v8a",
        packageId: "sh.paseo.iexalt",
        versionCode: android.versionCode,
        signingCertificateSha256: android.signingCertificateSha256,
      },
    ],
  };
  return Buffer.from(serializeForkReleaseManifest(manifest));
}

/** Detached Ed25519 signature over the exact bytes, as 86 base64url characters. */
export function signManifest(
  bytes,
  privateKeyPem,
  publicPin = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  const key = createPrivateKey(privateKeyPem);
  assert.equal(key.asymmetricKeyType, "ed25519", "Release manifest key must be Ed25519");
  assert.equal(
    createPublicKey(key).export({ format: "jwk" }).x,
    publicPin,
    "Release manifest key does not match the pinned public key",
  );
  const signature = Buffer.from(sign(null, bytes, key).toString("base64url"));
  assert.equal(signature.length, 86);
  // Verify with the client's own verifier and validator before anything is uploaded.
  verifyReleaseManifestBytes(bytes, signature, publicPin);
  return signature;
}

/** The body of `## [version]` up to the next release heading. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?[ (]`);
  const start = lines.findIndex((line) => heading.test(line));
  assert.ok(start >= 0, `CHANGELOG.fork.md has no section for ${version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  assert.ok(body, `CHANGELOG.fork.md section for ${version} is empty`);
  return `${body}\n`;
}

function build(directory, env) {
  const version = env.VERSION;
  const names = assetNames(version);
  const read = (name) => readFileSync(join(directory, name));
  const closureBytes = read(names.macClosure);
  const mac = {
    archive: describeAsset(names.macArchive, read(names.macArchive)),
    closureManifest: describeAsset(names.macClosure, closureBytes),
    outputPath: env.MAC_OUTPUT_PATH,
  };
  const bytes = releaseManifestBytes({
    version,
    sourceSha: env.SOURCE_SHA,
    upstreamBase: env.UPSTREAM_BASE,
    mac,
    android: {
      apk: describeAsset(names.apk, read(names.apk)),
      versionCode: Number(env.APK_VERSION_CODE),
      signingCertificateSha256: env.APK_CERT_SHA256,
    },
  });
  validateNixArtifactClosure(
    closureBytes,
    {
      ...mac.archive,
      system: "aarch64-darwin",
      outputPath: mac.outputPath,
      closureManifest: mac.closureManifest,
    },
    { sourceSha: env.SOURCE_SHA, version },
  );
  const signature = signManifest(bytes, env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY);
  writeFileSync(join(directory, MANIFEST_ASSET), bytes, { flag: "wx" });
  writeFileSync(join(directory, SIGNATURE_ASSET), signature, { flag: "wx" });
  process.stdout.write(bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument] = process.argv.slice(2);
  if (command === "build") build(argument, process.env);
  else if (command === "notes")
    process.stdout.write(changelogSection(readFileSync("CHANGELOG.fork.md", "utf8"), argument));
  else throw new Error("Usage: release-manifest.mjs build <dir> | notes <version>");
}
