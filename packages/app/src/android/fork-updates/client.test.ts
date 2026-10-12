import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    failStagedWrite: false,
    native: {
      getInstalledVersionCode: vi.fn(() => 201000),
      getInstalledVersion: vi.fn(() => "0.1.0"),
      openInstaller: vi.fn(async () => undefined),
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

vi.mock("./release", async () => ({
  ...(await vi.importActual<typeof import("./release")>("./release")),
  FORK_REPOSITORY: "iExalt/paseo",
  RELEASE_MANIFEST_NAME: "paseo-release-manifest.json",
  RELEASE_SIGNATURE_NAME: "paseo-release-manifest.sig",
  MAX_RELEASE_METADATA_BYTES: 262_144,
  findHighestVerifiedForkRelease: vi.fn(),
  verifyReleaseBinding: vi.fn(),
  verifySignedManifest: vi.fn(() => manifest),
}));

import {
  downloadForkUpdate,
  restoreStagedForkUpdate,
  launchForkUpdateInstaller,
  recordInstalledForkUpdate,
  ForkManualMigrationRequired,
} from "./client";
import { forkReleaseManifestFixture } from "../../../../../scripts/test-fixtures/fork-release-manifest";
import { approvedAndroidArtifact } from "./release";

const manifest = forkReleaseManifestFixture("0.1.1");

const update = {
  manifest,
  android: approvedAndroidArtifact(manifest),
  manifestText: "signed manifest bytes",
  signatureText: "detached signature",
  apkUrl: "https://github.com/iExalt/paseo/releases/download/tag/Paseo.apk",
} as never;

describe("fork update staged receipt recovery", () => {
  beforeEach(() => {
    harness.storage.clear();
    harness.failStagedWrite = false;
    harness.native.getInstalledVersionCode.mockReturnValue(201000);
    harness.native.getInstalledVersion.mockReturnValue("0.1.0");
    harness.native.openInstaller.mockClear();
    harness.native.downloadAndVerifyApk.mockClear();
    harness.native.findVerifiedStagedApk.mockClear();
  });

  it("recovers a verified APK when receipt promotion fails after native staging", async () => {
    harness.failStagedWrite = true;
    await expect(downloadForkUpdate(update)).rejects.toThrow("storage unavailable");
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged-pending")).toBe(true);
    expect(harness.native.downloadAndVerifyApk).toHaveBeenCalledOnce();
    expect(harness.native.downloadAndVerifyApk).toHaveBeenCalledWith(
      "https://github.com/iExalt/paseo/releases/download/paseo-v0.1.1/paseo.apk",
      "fork-v0.1.1-paseo.apk",
      123,
      "a".repeat(64),
      "sh.paseo.iexalt",
      201001,
      "0.1.1",
      "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459",
    );
    expect(harness.storage.get("@getpaseo/fork-update/semver-v1/high-water")).toBe("0.1.0");

    const restored = await restoreStagedForkUpdate();
    expect(restored?.path).toBe("/private/fork-update.apk");
    expect(restored?.update.manifest.version).toBe("0.1.1");
    expect(harness.native.findVerifiedStagedApk).toHaveBeenCalledOnce();
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged")).toBe(true);
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged-pending")).toBe(false);
  });

  it("records an exact installed candidate after process restart", async () => {
    harness.native.getInstalledVersionCode.mockReturnValue(201001);
    harness.native.getInstalledVersion.mockReturnValue("0.1.1");
    harness.storage.set(
      "@getpaseo/fork-update/semver-v1/staged",
      JSON.stringify({
        manifestText: "signed manifest bytes",
        signatureText: "detached signature",
      }),
    );

    expect(await restoreStagedForkUpdate()).toBeNull();
    expect(harness.storage.get("@getpaseo/fork-update/semver-v1/high-water")).toBe("0.1.1");
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged")).toBe(false);
  });

  it("retains a valid pending receipt when promotion fails and retries recovery", async () => {
    harness.storage.set(
      "@getpaseo/fork-update/semver-v1/staged-pending",
      JSON.stringify({
        manifestText: "signed manifest bytes",
        signatureText: "detached signature",
      }),
    );
    harness.failStagedWrite = true;

    await expect(restoreStagedForkUpdate()).rejects.toThrow("storage unavailable");
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged-pending")).toBe(true);
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged")).toBe(false);

    const restored = await restoreStagedForkUpdate();
    expect(restored?.path).toBe("/private/fork-update.apk");
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged-pending")).toBe(false);
    expect(harness.storage.has("@getpaseo/fork-update/semver-v1/staged")).toBe(true);
  });
  it("preserves legacy receipts without treating their sequences as new-lineage versions", async () => {
    const legacyKeys = ["installed-sequence", "staged", "staged-pending"];
    for (const key of legacyKeys) harness.storage.set(`@getpaseo/fork-update/${key}`, "200008");
    expect(await restoreStagedForkUpdate()).toBeNull();
    expect(harness.storage.get("@getpaseo/fork-update/semver-v1/high-water")).toBe("0.1.0");
    for (const key of legacyKeys)
      expect(harness.storage.get(`@getpaseo/fork-update/${key}`)).toBe("200008");
    harness.native.getInstalledVersionCode.mockReturnValue(200008);
    await expect(restoreStagedForkUpdate()).rejects.toBeInstanceOf(ForkManualMigrationRequired);
  });

  it("retains high-water after manual rollback and rejects stale installer intent", async () => {
    await downloadForkUpdate(update);
    harness.storage.set("@getpaseo/fork-update/semver-v1/high-water", "0.1.2");
    await expect(launchForkUpdateInstaller(update, "/private/fork-update.apk")).rejects.toThrow(
      "high-water",
    );
    expect(harness.native.openInstaller).not.toHaveBeenCalled();
    expect(await restoreStagedForkUpdate()).toBeNull();
    expect(harness.storage.get("@getpaseo/fork-update/semver-v1/high-water")).toBe("0.1.2");
    await expect(recordInstalledForkUpdate("0.1.1")).rejects.toThrow("not installed");
  });
});
