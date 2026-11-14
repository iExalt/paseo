import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getForkAndroidVersionCode,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
  it("derives fork encoding from semver and rejects a disagreeing environment override", () => {
    expect(getForkAndroidVersionCode("0.1.0")).toBe(201000);
    expect(getForkAndroidVersionCode("0.1.0", "201000")).toBe(201000);
    expect(() => getForkAndroidVersionCode("0.1.0", "200008")).toThrow("semver encoding");
    expect(resolveAppVariant("fork", 1000, "0.1.0", "201000")).toEqual({
      androidVersionCode: 201000,
});
