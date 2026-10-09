import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    failStagedWrite: false,
    native: {
      getInstalledVersionCode: vi.fn(() => 10),
      downloadAndVerifyApk: vi.fn(async () => "/private/fork-update.apk"),
      findVerifiedStagedApk: vi.fn(async () => "/private/fork-update.apk"),
    },
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (key.endsWith("/staged") && harness.failStagedWrite) {
        harness.failStagedWrite = false;
        throw new Error("storage unavailable");
      }
      harness.storage.set(key, value);
    },
    removeItem: async (key: string) => harness.storage.delete(key),
    multiRemove: async (keys: string[]) => keys.forEach((key) => harness.storage.delete(key)),
  },
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => harness.native,
}));

vi.mock("./release", () => ({
  FORK_REPOSITORY: "iExalt/paseo",
  RELEASE_MANIFEST_NAME: "paseo-release-manifest.json",
  RELEASE_SIGNATURE_NAME: "paseo-release-manifest.sig",
  MAX_RELEASE_METADATA_BYTES: 262_144,
  assertApprovedForkManifest: vi.fn(),
  findHighestVerifiedForkRelease: vi.fn(),
  isNewerThanInstalled: vi.fn(() => true),
  verifyReleaseBinding: vi.fn(),
  verifySignedManifest: vi.fn(() => manifest),
}));

import { downloadForkUpdate, restoreStagedForkUpdate } from "./client";

const manifest = {
  releaseSequence: 11,
  releaseTag: "paseo-fork-v0.11.0-r11-0123456789abcdef0123456789abcdef01234567",
  android: {
    apk: { name: "Paseo.apk", bytes: 100, sha256: "a".repeat(64) },
    packageId: "sh.paseo.iexalt",
    versionCode: 11,
    signingCertificateSha256: "b".repeat(64),
  },
};

const update = {
  manifest,
  manifestText: "signed manifest bytes",
  signatureText: "detached signature",
  apkUrl: "https://github.com/iExalt/paseo/releases/download/tag/Paseo.apk",
} as never;

describe("fork update staged receipt recovery", () => {
  beforeEach(() => {
    harness.storage.clear();
    harness.failStagedWrite = false;
    harness.native.getInstalledVersionCode.mockReturnValue(10);
    harness.native.downloadAndVerifyApk.mockClear();
    harness.native.findVerifiedStagedApk.mockClear();
  });

  it("recovers a verified APK when receipt promotion fails after native staging", async () => {
    harness.failStagedWrite = true;
    await expect(downloadForkUpdate(update)).rejects.toThrow("storage unavailable");
    expect(harness.storage.has("@getpaseo/fork-update/staged-pending")).toBe(true);
    expect(harness.native.downloadAndVerifyApk).toHaveBeenCalledOnce();

    const restored = await restoreStagedForkUpdate();
    expect(restored?.path).toBe("/private/fork-update.apk");
    expect(restored?.update.manifest.releaseSequence).toBe(11);
    expect(harness.native.findVerifiedStagedApk).toHaveBeenCalledOnce();
    expect(harness.storage.has("@getpaseo/fork-update/staged")).toBe(true);
    expect(harness.storage.has("@getpaseo/fork-update/staged-pending")).toBe(false);
  });

  it("records an exact installed candidate after process restart", async () => {
    harness.native.getInstalledVersionCode.mockReturnValue(11);
    harness.storage.set(
      "@getpaseo/fork-update/staged",
      JSON.stringify({
        manifestText: "signed manifest bytes",
        signatureText: "detached signature",
      }),
    );

    expect(await restoreStagedForkUpdate()).toBeNull();
    expect(harness.storage.get("@getpaseo/fork-update/installed-sequence")).toBe("11");
    expect(harness.storage.has("@getpaseo/fork-update/staged")).toBe(false);
  });

  it("retains a valid pending receipt when promotion fails and retries recovery", async () => {
    harness.storage.set(
      "@getpaseo/fork-update/staged-pending",
      JSON.stringify({
        manifestText: "signed manifest bytes",
        signatureText: "detached signature",
      }),
    );
    harness.failStagedWrite = true;

    await expect(restoreStagedForkUpdate()).rejects.toThrow("storage unavailable");
    expect(harness.storage.has("@getpaseo/fork-update/staged-pending")).toBe(true);
    expect(harness.storage.has("@getpaseo/fork-update/staged")).toBe(false);

    const restored = await restoreStagedForkUpdate();
    expect(restored?.path).toBe("/private/fork-update.apk");
    expect(harness.storage.has("@getpaseo/fork-update/staged-pending")).toBe(false);
    expect(harness.storage.has("@getpaseo/fork-update/staged")).toBe(true);
  });
});
