import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getForkAndroidVersionCodeFromRunNumber,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
  getRequiredAndroidVersionCode,
} = require("./native-release-version");
const { resolveAppVariant, validateForkGoogleServicesConfig } = require("./app-variant");

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

  it("requires a canonical positive Android version code within the platform limit", () => {
    expect(getRequiredAndroidVersionCode("1")).toBe(1);
    expect(getRequiredAndroidVersionCode("2100000000")).toBe(2_100_000_000);
    expect(() => getRequiredAndroidVersionCode(undefined)).toThrow("PASEO_ANDROID_VERSION_CODE");
    expect(() => getRequiredAndroidVersionCode("0")).toThrow("PASEO_ANDROID_VERSION_CODE");
    expect(() => getRequiredAndroidVersionCode("1.5")).toThrow("PASEO_ANDROID_VERSION_CODE");
    expect(() => getRequiredAndroidVersionCode("2100000001")).toThrow("PASEO_ANDROID_VERSION_CODE");
  });

  it("derives a stable fork version code from the persistent workflow run number", () => {
    expect(getForkAndroidVersionCodeFromRunNumber("1")).toBe(100_001);
    expect(getForkAndroidVersionCodeFromRunNumber("42")).toBe(100_042);
    expect(getForkAndroidVersionCodeFromRunNumber("2099900000")).toBe(2_100_000_000);
    expect(() => getForkAndroidVersionCodeFromRunNumber(undefined)).toThrow(
      "PASEO_ANDROID_VERSION_CODE",
    );
    expect(() => getForkAndroidVersionCodeFromRunNumber("2099900001")).toThrow(
      "GitHub run number is too large",
    );
  });

  it("resolves fork Android identity while keeping its iOS and existing identities stable", () => {
    expect(resolveAppVariant("fork", 11000, "23456")).toEqual({
      name: "Paseo iExalt",
      iosBundleIdentifier: "sh.paseo",
      androidPackage: "sh.paseo.iexalt",
      androidVersionCode: 23456,
    });
    expect(resolveAppVariant("production", 11000, "invalid")).toEqual({
      name: "Paseo",
      iosBundleIdentifier: "sh.paseo",
      androidPackage: "sh.paseo",
      androidVersionCode: 11000,
    });
    expect(resolveAppVariant("development", 11000, "invalid")).toEqual({
      name: "Paseo Debug",
      iosBundleIdentifier: "sh.paseo.debug",
      androidPackage: "sh.paseo.debug",
      androidVersionCode: 11000,
    });
  });

  it("requires the fork Google services config to match the expected project and Android package", () => {
    const config = {
      project_info: { project_id: "verified-project" },
      client: [{ client_info: { android_client_info: { package_name: "sh.paseo.iexalt" } } }],
    };

    expect(validateForkGoogleServicesConfig(config, "verified-project")).toBe(true);
    expect(() => validateForkGoogleServicesConfig(config, "different-project")).toThrow(
      "sh.paseo.iexalt",
    );
    expect(() =>
      validateForkGoogleServicesConfig(
        {
          ...config,
          client: [{ client_info: { android_client_info: { package_name: "sh.paseo.debug" } } }],
        },
        "verified-project",
      ),
    ).toThrow("sh.paseo.iexalt");
    expect(() => validateForkGoogleServicesConfig(config, " ")).toThrow("sh.paseo.iexalt");
  });
});
