import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  checkForForkUpdate: vi.fn(),
  downloadForkUpdate: vi.fn(),
  canInstallForkUpdate: vi.fn(),
  launchForkUpdateInstaller: vi.fn(),
  restoreStagedForkUpdate: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { forkUpdatesEnabled: true } } },
}));
vi.mock("./client", () => ({
  ForkManualMigrationRequired: class extends Error {},
  forkUpdatesNative: {
    getInstalledVersion: () => "0.1.0",
    addListener: () => ({ remove: () => undefined }),
  },
  checkForForkUpdate: harness.checkForForkUpdate,
  downloadForkUpdate: harness.downloadForkUpdate,
  canInstallForkUpdate: harness.canInstallForkUpdate,
  openForkUpdateInstallSettings: vi.fn(),
  launchForkUpdateInstaller: harness.launchForkUpdateInstaller,
  recordInstalledForkUpdate: vi.fn(),
  restoreStagedForkUpdate: harness.restoreStagedForkUpdate,
  clearStagedForkUpdate: vi.fn(),
}));

const update = { manifest: { version: "0.1.1" }, android: { bytes: 100 } } as never;
const newerUpdate = { manifest: { version: "0.1.2" }, android: { bytes: 100 } } as never;
let store: typeof import("./store");

describe("fork update store", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    store = await import("./store");
    harness.checkForForkUpdate.mockResolvedValue({ update, installedVersion: "0.1.0" });
    harness.downloadForkUpdate.mockResolvedValue("/files/update.apk");
    harness.canInstallForkUpdate.mockResolvedValue(true);
    harness.launchForkUpdateInstaller.mockResolvedValue(undefined);
    harness.restoreStagedForkUpdate.mockResolvedValue(null);
  });

  it("downloads and opens the installer from the sidebar icon in one press", async () => {
    await store.checkForForkUpdateNow({ userInitiated: false });
    expect(store.hasPendingForkUpdate(store.useForkUpdateStore.getState())).toBe(true);

    await store.updateToPendingForkRelease();

    expect(harness.downloadForkUpdate).toHaveBeenCalledWith(update);
    expect(harness.launchForkUpdateInstaller).toHaveBeenCalledWith(update, "/files/update.apk");
    expect(store.useForkUpdateStore.getState().status).toBe("installing");
  });

  it("keeps a downloaded release but lets a newer one replace it", async () => {
    await store.checkForForkUpdateNow({ userInitiated: false });
    await store.downloadPendingForkUpdate();

    await store.checkForForkUpdateNow({ userInitiated: false });
    expect(store.useForkUpdateStore.getState()).toMatchObject({
      status: "downloaded",
      update,
      apkPath: "/files/update.apk",
    });

    harness.checkForForkUpdate.mockResolvedValue({
      update: newerUpdate,
      installedVersion: "0.1.0",
    });
    await store.checkForForkUpdateNow({ userInitiated: false });
    expect(store.useForkUpdateStore.getState()).toMatchObject({
      status: "available",
      update: newerUpdate,
      apkPath: null,
    });
  });

  it("keeps the last result when a background check fails", async () => {
    await store.checkForForkUpdateNow({ userInitiated: false });
    harness.checkForForkUpdate.mockRejectedValue(new Error("offline"));

    await store.checkForForkUpdateNow({ userInitiated: false });

    expect(store.useForkUpdateStore.getState()).toMatchObject({ status: "available", update });
  });
});
