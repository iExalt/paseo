import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyReleaseManifestBytes } from "../../scripts/paseo-nix-update.mjs";

const directory = process.argv[2];
const manifest = verifyReleaseManifestBytes(
  await readFile(join(directory, "paseo-release-manifest.json")),
  await readFile(join(directory, "paseo-release-manifest.sig")),
);
assert.equal(manifest.sourceSha, "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a");
assert.equal(manifest.releaseSequence, 200008);
assert.equal(
  manifest.releaseTag,
  "paseo-fork-v0.11.0-r200008-5619b7d7ee1e55b322028e8b7818aa1a8f752a0a",
);
assert.equal(manifest.android.apk.name, "paseo-android-arm64.apk");
const apkPath = join(directory, manifest.android.apk.name);
const apk = await readFile(apkPath);
assert.equal(apk.length, manifest.android.apk.bytes);
assert.equal(createHash("sha256").update(apk).digest("hex"), manifest.android.apk.sha256);
const certificate = execFileSync("apksigner", ["verify", "--print-certs", apkPath], {
  encoding: "utf8",
  timeout: 30_000,
});
const fingerprints = [...certificate.matchAll(/^Signer #\d+ certificate SHA-256 digest: (\w+)$/gm)];
assert.equal(fingerprints.length, 1);
assert.equal(fingerprints[0][1].toLowerCase(), manifest.android.signingCertificateSha256);
const badging = execFileSync("aapt", ["dump", "badging", apkPath], {
  encoding: "utf8",
  timeout: 30_000,
});
assert.match(badging, /^package: name='sh\.paseo\.iexalt' versionCode='200008'/m);
assert.match(badging, /^native-code: 'arm64-v8a'\s*$/m);
console.log("PASS: pinned signed manifest, APK bytes/hash, certificate, package and ARM64 ABI");
