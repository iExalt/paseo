import assert from "node:assert/strict";
import test from "node:test";
import { compareForkVersions, forkAndroidVersionCode } from "./fork-version.mjs";
import {
  computeNextReleaseVersion,
  getReleaseInfoFromSourceTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

test("computes the next beta patch from a stable version", () => {
  assert.equal(computeNextReleaseVersion("0.1.59", "beta-patch"), "0.1.60-beta.1");
});

test("advances beta versions", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.1", "beta-next"), "0.1.60-beta.2");
});

test("promotes beta versions to stable", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.2", "promote"), "0.1.60");
});

test("parses beta release metadata", () => {
  assert.deepEqual(parseReleaseVersion("0.1.60-beta.1"), {
    version: "0.1.60-beta.1",
    major: 0,
    minor: 1,
    patch: 60,
    prerelease: "beta.1",
    baseVersion: "0.1.60",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
  });
});

test("emits beta release info from tags", () => {
  assert.deepEqual(getReleaseInfoFromSourceTag("v0.1.60-beta.1"), {
    sourceTag: "v0.1.60-beta.1",
    releaseTag: "v0.1.60-beta.1",
    version: "0.1.60-beta.1",
    baseVersion: "0.1.60",
    prerelease: "beta.1",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
    releaseType: "prerelease",
    releaseChannel: "beta",
    isSmokeTag: false,
  });
});

test("rejects non-beta prerelease versions", () => {
  assert.throws(() => parseReleaseVersion("0.1.60-canary.1"), /Expected beta prerelease versions/);
});

test("fork stable semver orders Android codes across component boundaries", () => {
  assert.equal(forkAndroidVersionCode("0.1.0"), 201000);
  for (const [before, after] of [
    ["0.1.0", "0.1.1"],
    ["0.1.999", "0.2.0"],
    ["0.999.999", "1.0.0"],
  ]) {
    assert.equal(compareForkVersions(before, after), -1);
    assert.equal(compareForkVersions(after, before), 1);
    assert.ok(forkAndroidVersionCode(before) < forkAndroidVersionCode(after));
  }
  assert.equal(compareForkVersions("0.1.0", "0.1.0"), 0);
});

test("fork Android encoding rejects ambiguous versions and collisions", () => {
  for (const value of [
    "01.1.0",
    "0.01.0",
    "0.1.00",
    "0.1.0-beta.1",
    "0.1.0+build",
    " 0.1.0",
    "0.1000.0",
    "0.1.1000",
    "9007199254740992.0.0",
    null,
  ]) {
    assert.throws(() => forkAndroidVersionCode(value));
  }
  assert.equal(forkAndroidVersionCode("2099.800.0"), 2_100_000_000);
  assert.throws(() => forkAndroidVersionCode("2099.800.1"), /versionCode range/);
});
