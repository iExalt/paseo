// The release asset catalog: every asset name a fork release carries, and the
// check that a release directory holds exactly that set. Release scripts and
// release-publish.sh query it instead of spelling names themselves. Desktop
// delta and index names belong to the shipped updater
// (scripts/paseo-nix-update-delta.mjs), which reads them back; the app's own
// readers (release.ts, the Kotlin updater) ship to users and keep their copies.
// The CLI makes every set comparison itself, so no shell sort order is involved.
//   check <dir>                       check <dir> holds exactly VERSION's set; print it
//   check-listing <assets.json> <dir> check a release's asset listing names the same set
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deltaAssetName, indexAssetName } from "../../scripts/paseo-nix-update-delta.mjs";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const MANIFEST_ASSET = "paseo-release-manifest.json";
export const SIGNATURE_ASSET = "paseo-release-manifest.sig";

/** The fixed assets of one release, by role. */
export function releaseAssets(version) {
  assert.match(version, VERSION);
  const mac = `paseo-${version}-macos-arm64-nix-desktop`;
  const apk = `paseo-${version}-android-arm64.apk`;
  return {
    manifest: MANIFEST_ASSET,
    signature: SIGNATURE_ASSET,
    macArchive: `${mac}.tar`,
    macClosure: `${mac}.json`,
    macIndex: indexAssetName(`${mac}.tar`),
    apk,
    apkGzip: `${apk}.gz`,
    androidCachePin: `paseo-${version}-android-cache-pin.json`,
    linuxX64Archive: `paseo-${version}-linux-x64-nix.tar`,
    linuxX64Closure: `paseo-${version}-linux-x64-nix.json`,
    linuxArm64Archive: `paseo-${version}-linux-arm64-nix.tar`,
    linuxArm64Closure: `paseo-${version}-linux-arm64-nix.json`,
    windowsInstaller: `paseo-${version}-windows-x64.exe`,
  };
}

/** The unsigned APK delta from fromVersion's signed APK (PaseoForkUpdatesModule.kt reads it). */
export function apkDeltaAssetName(version, fromVersion) {
  assert.match(fromVersion, VERSION);
  return `${releaseAssets(version).apk}.delta-from-${fromVersion}.zst`;
}

/** The desktop delta from fromVersion's NAR, as the shipped updater names it. */
export const desktopDeltaAssetName = (version, fromVersion) =>
  deltaAssetName(releaseAssets(version).macArchive, fromVersion);

/** Which delta of version's release a name is, or null when it is not one. */
export function parseDeltaAsset(version, name) {
  const from = /\.delta-from-([0-9]+\.[0-9]+\.[0-9]+)\.zst$/.exec(name)?.[1];
  if (!from) return null;
  if (name === apkDeltaAssetName(version, from)) return { kind: "apk", fromVersion: from };
  if (name === desktopDeltaAssetName(version, from)) return { kind: "desktop", fromVersion: from };
  return null;
}

/**
 * The exact upload set for version, sorted: the fixed assets, the desktop
 * deltas the unsigned index lists (none up to DELTA_BASE_RELEASES), and any
 * correctly named APK deltas present. Throws unless files is exactly that set.
 */
export function expectedAssets(version, files, index) {
  const listed = index.deltas.map((delta) => delta.asset);
  if (!listed.every((name) => parseDeltaAsset(version, name)?.kind === "desktop")) {
    throw new Error("Unexpected delta asset name.");
  }
  const apkDeltas = files.filter((name) => parseDeltaAsset(version, name)?.kind === "apk");
  const expected = [...Object.values(releaseAssets(version)), ...listed, ...apkDeltas].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected release asset set.");
  }
  return expected;
}

function readIndex(version, directory) {
  return JSON.parse(readFileSync(join(directory, releaseAssets(version).macIndex), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  const version = process.env.VERSION;
  try {
    if (command === "check" && args.length === 1) {
      const [directory] = args;
      const expected = expectedAssets(
        version,
        readdirSync(directory),
        readIndex(version, directory),
      );
      for (const name of expected) console.log(name);
    } else if (command === "check-listing" && args.length === 2) {
      const [listing, directory] = args;
      const expected = expectedAssets(
        version,
        readdirSync(directory),
        readIndex(version, directory),
      );
      const uploaded = JSON.parse(readFileSync(listing, "utf8")).map((asset) => asset.name);
      if (JSON.stringify(uploaded.sort()) !== JSON.stringify(expected)) {
        throw new Error("Release assets differ from the upload set.");
      }
    } else {
      throw new Error("Usage: release-assets.mjs check <dir> | check-listing <assets.json> <dir>");
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
