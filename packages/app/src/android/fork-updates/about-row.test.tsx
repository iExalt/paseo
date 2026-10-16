/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  activeListener: null as ((state: string) => void) | null,
  installedVersion: "0.1.0",
  allowInstall: false,
  checkForForkUpdate: vi.fn(),
  downloadForkUpdate: vi.fn(),
  canInstallForkUpdate: vi.fn(),
  openForkUpdateInstallSettings: vi.fn(),
  launchForkUpdateInstaller: vi.fn(),
  recordInstalledForkUpdate: vi.fn(),
  restoreStagedForkUpdate: vi.fn(),
  nativeListener: vi.fn(),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: "android" },
    AppState: {
      addEventListener: (_event: string, listener: (state: string) => void) => {
        harness.activeListener = listener;
        return { remove: () => (harness.activeListener = null) };
      },
    },
  };
});

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { forkUpdatesEnabled: true } } },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children: React.ReactNode;
      onPress(): void;
      disabled?: boolean;
    }) =>
      ReactModule.createElement("button", { type: "button", onClick: onPress, disabled }, children),
  };
});

vi.mock("@/styles/settings", () => ({
  settingsStyles: { row: {}, rowBorder: {}, rowContent: {}, rowTitle: {}, rowHint: {} },
}));
vi.mock("./client", () => ({
  ForkManualMigrationRequired: class extends Error {},
  forkUpdatesNative: {
    getInstalledVersion: () => harness.installedVersion,
    addListener: (_name: string, listener: (event: { downloadedBytes: number }) => void) => {
      harness.nativeListener.mockImplementation(listener);
      return { remove: () => harness.nativeListener.mockReset() };
    },
  },
  checkForForkUpdate: harness.checkForForkUpdate,
  downloadForkUpdate: harness.downloadForkUpdate,
  canInstallForkUpdate: harness.canInstallForkUpdate,
  openForkUpdateInstallSettings: harness.openForkUpdateInstallSettings,
  launchForkUpdateInstaller: harness.launchForkUpdateInstaller,
  recordInstalledForkUpdate: harness.recordInstalledForkUpdate,
  restoreStagedForkUpdate: harness.restoreStagedForkUpdate,
  clearStagedForkUpdate: vi.fn(),
}));

let ForkAndroidUpdateRow: typeof import("./about-row").ForkAndroidUpdateRow;
let ForkManualMigrationRequired: typeof import("./client").ForkManualMigrationRequired;

const update = {
  manifest: {
    version: "0.1.1",
  },
  android: { bytes: 100 },
  apkUrl: "https://github.com/iExalt/paseo/releases/download/test/update.apk",
} as never;

describe("fork Android update row", () => {
  beforeEach(async () => {
    // The updater state lives in modules; start every test from a fresh copy.
    vi.resetModules();
    ({ ForkAndroidUpdateRow } = await import("./about-row"));
    ({ ForkManualMigrationRequired } = await import("./client"));
    harness.installedVersion = "0.1.0";
    harness.allowInstall = false;
    harness.checkForForkUpdate.mockResolvedValue({ update, installedVersion: "0.1.0" });
    harness.downloadForkUpdate.mockResolvedValue("/private/files/fork-updates/update.apk");
    harness.canInstallForkUpdate.mockImplementation(async () => harness.allowInstall);
    harness.openForkUpdateInstallSettings.mockResolvedValue(undefined);
    harness.launchForkUpdateInstaller.mockResolvedValue(undefined);
    harness.recordInstalledForkUpdate.mockResolvedValue(undefined);
    harness.restoreStagedForkUpdate.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("checks manually, downloads, asks Android for permission, and distinguishes cancel from install", async () => {
    render(<ForkAndroidUpdateRow />);
    expect(screen.getByText("settings.about.forkUpdates.idle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.check" }));
    await screen.findByText('settings.about.forkUpdates.available {"version":"0.1.1"}');

    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.download" }));
    await screen.findByText('settings.about.forkUpdates.downloaded {"version":"0.1.1"}');

    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.install" }));
    await screen.findByText("settings.about.forkUpdates.permission");
    expect(harness.openForkUpdateInstallSettings).toHaveBeenCalledOnce();
    expect(harness.launchForkUpdateInstaller).not.toHaveBeenCalled();

    harness.allowInstall = true;
    harness.activeListener?.("active");
    await screen.findByText('settings.about.forkUpdates.downloaded {"version":"0.1.1"}');
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.install" }));
    await screen.findByText("settings.about.forkUpdates.installer");
    expect(harness.launchForkUpdateInstaller).toHaveBeenCalledOnce();

    harness.activeListener?.("active");
    await screen.findByText("settings.about.forkUpdates.canceled");
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.install" }));
    await waitFor(() => expect(harness.launchForkUpdateInstaller).toHaveBeenCalledTimes(2));

    harness.installedVersion = "0.1.1";
    harness.activeListener?.("active");
    await screen.findByText('settings.about.forkUpdates.installed {"version":"0.1.1"}');
    expect(harness.recordInstalledForkUpdate).toHaveBeenCalledWith("0.1.1");
  });

  it("remembers a found update after the About screen closes", async () => {
    const first = render(<ForkAndroidUpdateRow />);
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.check" }));
    await screen.findByText('settings.about.forkUpdates.available {"version":"0.1.1"}');
    first.unmount();

    render(<ForkAndroidUpdateRow />);
    expect(
      screen.getByText('settings.about.forkUpdates.available {"version":"0.1.1"}'),
    ).toBeTruthy();
    expect(harness.checkForForkUpdate).toHaveBeenCalledOnce();
  });

  it("shows a retryable error when installer-return persistence fails", async () => {
    harness.allowInstall = true;
    harness.recordInstalledForkUpdate.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<ForkAndroidUpdateRow />);
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.check" }));
    await screen.findByText('settings.about.forkUpdates.available {"version":"0.1.1"}');
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.download" }));
    await screen.findByText('settings.about.forkUpdates.downloaded {"version":"0.1.1"}');
    fireEvent.click(screen.getByRole("button", { name: "settings.about.forkUpdates.install" }));
    await screen.findByText("settings.about.forkUpdates.installer");

    harness.installedVersion = "0.1.1";
    harness.activeListener?.("active");
    await screen.findByText("settings.about.forkUpdates.failed");
    expect(screen.getByRole("button", { name: "settings.about.forkUpdates.install" })).toBeTruthy();
  });

  it("explains that a legacy installation requires manual migration", async () => {
    harness.restoreStagedForkUpdate.mockRejectedValueOnce(new ForkManualMigrationRequired());
    render(<ForkAndroidUpdateRow />);
    expect(await screen.findByText(/Install the fork 0.1.0 or newer manually/)).toBeTruthy();
  });
});
