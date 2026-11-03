import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expectedAssets, parseDeltaAsset, releaseAssets } from "./release-assets.mjs";

// paseo-v0.18.0 as published: `gh release view paseo-v0.18.0 --json assets` and its index's deltas.
const published = {
  version: "0.18.0",
  deltas: ["0.17.1", "0.16.0", "0.15.0", "0.14.0"].map(
    (from) => `paseo-0.18.0-macos-arm64-nix-desktop.delta-from-${from}.zst`,
  ),
  assets: [
    "paseo-0.18.0-android-arm64.apk",
    "paseo-0.18.0-android-arm64.apk.delta-from-0.14.0.zst",
    "paseo-0.18.0-android-arm64.apk.delta-from-0.15.0.zst",
    "paseo-0.18.0-android-arm64.apk.delta-from-0.16.0.zst",
    "paseo-0.18.0-android-arm64.apk.delta-from-0.17.1.zst",
    "paseo-0.18.0-android-arm64.apk.gz",
    "paseo-0.18.0-android-cache-pin.json",
    "paseo-0.18.0-linux-arm64-nix.json",
    "paseo-0.18.0-linux-arm64-nix.tar",
    "paseo-0.18.0-linux-x64-nix.json",
    "paseo-0.18.0-linux-x64-nix.tar",
    "paseo-0.18.0-macos-arm64-nix-desktop.delta-from-0.14.0.zst",
    "paseo-0.18.0-macos-arm64-nix-desktop.delta-from-0.15.0.zst",
    "paseo-0.18.0-macos-arm64-nix-desktop.delta-from-0.16.0.zst",
    "paseo-0.18.0-macos-arm64-nix-desktop.delta-from-0.17.1.zst",
    "paseo-0.18.0-macos-arm64-nix-desktop.index.json",
    "paseo-0.18.0-macos-arm64-nix-desktop.json",
    "paseo-0.18.0-macos-arm64-nix-desktop.tar",
    "paseo-0.18.0-windows-x64.exe",
    "paseo-release-manifest.json",
    "paseo-release-manifest.sig",
  ],
};
const index = (deltas) => ({ deltas: deltas.map((asset) => ({ asset })) });

test("the catalog names exactly what the last published release carries", () => {
  const { version, assets, deltas } = published;
  assert.deepEqual(expectedAssets(version, assets, index(deltas)), [...assets].sort());
  for (const name of assets.filter((asset) => asset.includes(".delta-from-")))
    assert.ok(parseDeltaAsset(version, name), name);
  assert.equal(releaseAssets(version).macIndex, "paseo-0.18.0-macos-arm64-nix-desktop.index.json");
});

test("the upload set rejects missing, extra, duplicate and misnamed assets", () => {
  const { version, assets, deltas } = published;
  const without = (name) => assets.filter((asset) => asset !== name);
  const fixed = Object.values(releaseAssets(version));
  for (const [label, files, listed, message] of [
    ["a missing fixed asset", without(fixed[2]), deltas, /asset set/],
    ["an unlisted desktop delta file", assets, deltas.slice(1), /asset set/],
    ["a listed delta file that is missing", without(deltas[0]), deltas, /asset set/],
    ["a delta listed twice", assets, [...deltas, deltas[0]], /asset set/],
    ["a .part upload", [...assets, `${fixed[5]}.delta-from-0.17.1.zst.part`], deltas, /asset set/],
    [
      "a two-part APK delta version",
      [...assets, `${fixed[5]}.delta-from-0.17.zst`],
      deltas,
      /asset set/,
    ],
    [
      "an APK delta of another release",
      [...assets, "paseo-0.17.1-android-arm64.apk.delta-from-0.16.0.zst"],
      deltas,
      /asset set/,
    ],
    // A bad listed name fails as a name before the set is compared.
    [
      "a misnamed desktop delta",
      assets,
      [...deltas, `${fixed[2]}.delta-from-x.zst`],
      /delta asset name/,
    ],
    ["an APK delta listed as desktop", assets, [...deltas, assets[1]], /delta asset name/],
  ])
    assert.throws(() => expectedAssets(version, files, index(listed)), message, label);
});

test("publish's CLI compares the directory and the uploaded listing itself", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-release-assets-"));
  const script = fileURLToPath(new URL("./release-assets.mjs", import.meta.url));
  const cli = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, VERSION: published.version },
    });
  try {
    const assets = join(directory, "assets");
    mkdirSync(assets);
    for (const name of published.assets) writeFileSync(join(assets, name), "");
    writeFileSync(
      join(assets, releaseAssets(published.version).macIndex),
      JSON.stringify(index(published.deltas)),
    );
    const checked = cli("check", assets);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(checked.stdout.trim().split("\n"), [...published.assets].sort());
    const listing = join(directory, "listing.json");
    // GitHub lists assets in its own order.
    writeFileSync(listing, JSON.stringify(published.assets.toReversed().map((name) => ({ name }))));
    assert.equal(cli("check-listing", listing, assets).status, 0);
    writeFileSync(listing, JSON.stringify(published.assets.slice(1).map((name) => ({ name }))));
    const short = cli("check-listing", listing, assets);
    assert.equal(short.status, 1);
    assert.match(short.stderr, /::error::Release assets differ from the upload set/);
    writeFileSync(join(assets, "stray.txt"), "");
    const stray = cli("check", assets);
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /::error::Unexpected release asset set/);
    assert.equal(cli("unknown").status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
