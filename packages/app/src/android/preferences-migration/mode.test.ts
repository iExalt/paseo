import { describe, expect, it } from "vitest";
import { resolvePreferencesMigrationMode } from "./mode";

const { resolvePreferencesMigrationBridge } = require("../../../app-variant");

describe("preference migration startup mode", () => {
  it("gates both the fixed debug bridge and the fork receiver", () => {
    expect(
      resolvePreferencesMigrationMode({
        platform: "android",
        extra: { preferencesMigrationBridge: true },
        packageName: "sh.paseo.debug",
        versionCode: 11001,
      }),
    ).toBe("bridge");
    expect(
      resolvePreferencesMigrationMode({
        platform: "android",
        extra: { preferencesMigrationReceiver: true },
        packageName: "sh.paseo.iexalt",
        versionCode: 12000,
      }),
    ).toBe("receiver");
  });

  it("does not gate ordinary development or mismatched identities", () => {
    expect(
      resolvePreferencesMigrationMode({
        platform: "android",
        extra: {},
        packageName: "sh.paseo.debug",
        versionCode: 11001,
      }),
    ).toBeNull();
    expect(
      resolvePreferencesMigrationMode({
        platform: "android",
        extra: { preferencesMigrationReceiver: true },
        packageName: "sh.paseo.debug",
        versionCode: 11001,
      }),
    ).toBeNull();
    expect(
      resolvePreferencesMigrationMode({
        platform: "ios",
        extra: { preferencesMigrationReceiver: true },
        packageName: "sh.paseo.iexalt",
        versionCode: 12000,
      }),
    ).toBeNull();
  });

  it("rejects the bridge selector outside the development variant", () => {
    expect(resolvePreferencesMigrationBridge("development", true)).toBe(true);
    expect(resolvePreferencesMigrationBridge("development", false)).toBe(false);
    expect(() => resolvePreferencesMigrationBridge("fork", true)).toThrow();
    expect(() => resolvePreferencesMigrationBridge("production", true)).toThrow();
  });
});
