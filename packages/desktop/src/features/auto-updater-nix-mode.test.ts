import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  checkForAppUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  installUpdateOnQuit: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: vi.fn(), isPackaged: true } }));
vi.mock("electron-log/main", () => ({ default: { info: vi.fn() } }));
vi.mock("./nix-managed-install.js", () => ({
  resolveDesktopInstallation: () => ({ mode: "nix", outputPath: "/nix/store/test" }),
}));
vi.mock("./app-update-service.js", () => ({
  createAppUpdateService: () => service,
}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  installAppUpdateOnQuit,
} from "./auto-updater";

describe("Nix installation updater isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks direct Electron update APIs before they can query a release catalog", async () => {
    await expect(
      checkForAppUpdate({ currentVersion: "1.0.0", releaseChannel: "stable", intent: "manual" }),
    ).rejects.toThrow("disabled for Nix-managed");
    await expect(
      downloadAndInstallUpdate({ currentVersion: "1.0.0", releaseChannel: "stable" }),
    ).rejects.toThrow("disabled for Nix-managed");
    await expect(
      installAppUpdateOnQuit({
        currentVersion: "1.0.0",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("disabled for Nix-managed");

    expect(service.checkForAppUpdate).not.toHaveBeenCalled();
    expect(service.downloadAndInstallUpdate).not.toHaveBeenCalled();
    expect(service.installUpdateOnQuit).not.toHaveBeenCalled();
  });
});
