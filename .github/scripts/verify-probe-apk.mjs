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
assert.equal(manifest.sourceSha, "dba97434bc07ae122625dbd66568cf7e0624c578");
assert.equal(manifest.version, "0.1.0");
assert.equal(manifest.releaseTag, "paseo-v0.1.0");
const android = manifest.artifacts.find((entry) => entry.platform === "android");
assert.equal(android.name, "paseo-0.1.0-android-arm64.apk");
assert.equal(android.versionCode, 201000);
const apkPath = join(directory, android.name);
const apk = await readFile(apkPath);
assert.equal(apk.length, android.bytes);
assert.equal(createHash("sha256").update(apk).digest("hex"), android.sha256);
const certificate = execFileSync("apksigner", ["verify", "--print-certs", apkPath], {
  encoding: "utf8",
  timeout: 30_000,
});
const fingerprints = [...certificate.matchAll(/^Signer #\d+ certificate SHA-256 digest: (\w+)$/gm)];
assert.equal(fingerprints.length, 1);
assert.equal(fingerprints[0][1].toLowerCase(), android.signingCertificateSha256);
const badging = execFileSync("aapt", ["dump", "badging", apkPath], {
  encoding: "utf8",
  timeout: 30_000,
});
assert.match(
  badging,
  /^package: name='sh\.paseo\.iexalt' versionCode='201000' versionName='0\.1\.0'/m,
);
assert.match(badging, /^native-code: 'arm64-v8a'\s*$/m);
console.log("PASS: pinned signed manifest, APK bytes/hash, certificate, package and ARM64 ABI");
