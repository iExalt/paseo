import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForkUpdateController, type ForkUpdatePort } from "./controller";
import { ForkManualMigrationRequired, type VerifiedForkUpdate } from "./release";

const release = (version: string) =>
  ({ manifest: { version }, android: { bytes: 100 } }) as unknown as VerifiedForkUpdate;
const update = release("0.1.1");
const APK = "/files/update.apk";

/** The native updater in memory; tests play Android's part through its controls. */
function createFakePort() {
  let events: { foreground(): void; progress(downloaded: number, total: number): void } | null =
    null;
  const fake = {
    installed: "0.1.0",
    latest: update as VerifiedForkUpdate | null,
    allowInstall: true,
    check: vi.fn(async () => ({ update: fake.latest, installedVersion: fake.installed })),
    download: vi.fn(async (_update: VerifiedForkUpdate) => APK),
    restoreStaged: vi.fn(
      async (): Promise<{
        update: VerifiedForkUpdate;
        path: string;
        installedVersion: string;
      } | null> => null,
    ),
    canInstall: vi.fn(async () => fake.allowInstall),
    openInstallSettings: vi.fn(async () => undefined),
    // A successful update replaces the app process, so the install never settles.
    install: vi.fn((_update: VerifiedForkUpdate, _path: string) => new Promise<void>(() => {})),
    recordInstalled: vi.fn(async (_version: string) => undefined),
    clearStaged: vi.fn(async () => undefined),
    /** The user comes back to Paseo from Android's installer or settings. */
    foreground: () => events?.foreground(),
    progress: (downloaded: number, total: number) => events?.progress(downloaded, total),
  };
  const port: ForkUpdatePort = {
    installedVersion: () => fake.installed,
    check: fake.check,
    download: fake.download,
    restoreStaged: fake.restoreStaged,
    canInstall: fake.canInstall,
    openInstallSettings: fake.openInstallSettings,
    install: fake.install,
    recordInstalled: fake.recordInstalled,
    clearStaged: fake.clearStaged,
    watch(sink) {
      events = sink;
      return () => {
        events = null;
      };
    },
  };
  return { fake, port };
}

let fake: ReturnType<typeof createFakePort>["fake"];
let updater: ReturnType<typeof createForkUpdateController>;
let logs: string[];

const view = () => updater.views.getState();
const message = () => {
  const { key, params } = view().message;
  return params ? `${key} ${JSON.stringify(params)}` : key;
};
const label = () => view().row.labelKey.replace("settings.about.forkUpdates.", "");
const row = () => updater.send({ type: "press", via: "row" });
const icon = () => updater.send({ type: "press", via: "icon" });
const backgroundCheck = () => updater.send({ type: "check" });

beforeEach(() => {
  const created = createFakePort();
  fake = created.fake;
  updater = createForkUpdateController(created.port, { shown: true });
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: string) => void logs.push(line));
  updater.start();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fork updater controller", () => {
  it("downloads and opens the installer from the sidebar icon in one press", async () => {
    expect(view().icon).toBeNull();
    await backgroundCheck();
    expect(view().icon).toEqual({ version: "0.1.1", downloading: false });

    void icon();
    await vi.waitFor(() => expect(fake.install).toHaveBeenCalledWith(update, APK));
    expect(message()).toBe("settings.about.forkUpdates.installer");
    expect(view().row).toEqual({ labelKey: "settings.about.forkUpdates.check", disabled: true });
  });

  it("walks the row through permission, cancel, retry and install", async () => {
    await row();
    expect(message()).toBe('settings.about.forkUpdates.available {"version":"0.1.1"}');
    expect(label()).toBe("download");
    await row();
    expect(message()).toBe('settings.about.forkUpdates.downloaded {"version":"0.1.1"}');

    fake.allowInstall = false;
    await row();
    expect(message()).toBe("settings.about.forkUpdates.permission");
    expect(fake.openInstallSettings).toHaveBeenCalledOnce();
    // The permission screen keeps the icon and holds off a background check, but its
    // button stays pressable.
    expect(view().row).toEqual({
      labelKey: "settings.about.forkUpdates.continue",
      disabled: false,
    });
    expect(view().icon).not.toBeNull();
    await backgroundCheck();
    expect(fake.check).toHaveBeenCalledTimes(1);

    fake.foreground();
    await vi.waitFor(() => expect(message()).toBe("settings.about.forkUpdates.permission"));
    // One return from settings is handled once.
    const checks = fake.canInstall.mock.calls.length;
    fake.foreground();
    expect(fake.canInstall).toHaveBeenCalledTimes(checks);
    fake.allowInstall = true;
    await row();
    expect(label()).toBe("install");

    void row();
    await vi.waitFor(() => expect(message()).toBe("settings.about.forkUpdates.installer"));
    // Back from Android's confirmation without installing.
    fake.foreground();
    await vi.waitFor(() => expect(message()).toBe("settings.about.forkUpdates.canceled"));
    expect(label()).toBe("install");

    // The installer's own promise can settle after the foreground return has
    // reconciled; the reconcile wins.
    let settleInstaller = () => {};
    fake.install.mockReturnValueOnce(new Promise<void>((resolve) => (settleInstaller = resolve)));
    const pressed = row();
    await vi.waitFor(() => expect(fake.install).toHaveBeenCalledTimes(2));
    fake.installed = "0.1.1";
    fake.foreground();
    await vi.waitFor(() =>
      expect(message()).toBe('settings.about.forkUpdates.installed {"version":"0.1.1"}'),
    );
    settleInstaller();
    await pressed;
    expect(message()).toBe('settings.about.forkUpdates.installed {"version":"0.1.1"}');
    expect(fake.recordInstalled).toHaveBeenCalledWith("0.1.1");
    expect(view().icon).toBeNull();
  });

  it("continues from the permission screen through the sidebar icon", async () => {
    await backgroundCheck();
    fake.allowInstall = false;
    await icon();
    expect(message()).toBe("settings.about.forkUpdates.permission");
    // Still refused: the icon stops at Android's settings again.
    await icon();
    expect(fake.openInstallSettings).toHaveBeenCalledTimes(2);
    expect(fake.install).not.toHaveBeenCalled();
    fake.allowInstall = true;
    void icon();
    await vi.waitFor(() => expect(fake.install).toHaveBeenCalledOnce());
  });

  it("reports a canceled confirmation and a rejected install, logging the failure first", async () => {
    await backgroundCheck();
    fake.install.mockResolvedValueOnce(undefined);
    await icon();
    expect(message()).toBe("settings.about.forkUpdates.canceled");

    logs.length = 0;
    fake.install.mockRejectedValueOnce(new Error("INSTALL_FAILED"));
    await icon();
    expect(message()).toBe("settings.about.forkUpdates.installFailed");
    expect(label()).toBe("install");
    expect(logs).toEqual([
      "[paseo-agent] update status status=installing version=0.1.1",
      '[paseo-agent] update failed status=installing reason="Error: INSTALL_FAILED"',
      "[paseo-agent] update status status=error version=0.1.1",
    ]);
  });

  it("keeps a downloaded release but lets a newer one replace it", async () => {
    await row();
    await row();
    fake.install.mockResolvedValueOnce(undefined);
    await row();
    expect(message()).toBe("settings.about.forkUpdates.canceled");

    // A same-release background check keeps the download and the state it found.
    await backgroundCheck();
    expect(message()).toBe("settings.about.forkUpdates.canceled");
    expect(label()).toBe("install");

    fake.latest = release("0.1.2");
    await backgroundCheck();
    expect(message()).toBe('settings.about.forkUpdates.available {"version":"0.1.2"}');
    expect(label()).toBe("download");
  });

  it("tells an unreachable GitHub apart from a release that fails its checks", async () => {
    fake.check.mockRejectedValue(
      new Error(
        "Call to function 'PaseoForkUpdates.fetchText' has been rejected.\n→ Caused by: java.net.UnknownHostException: Unable to resolve host \"api.github.com\"",
      ),
    );
    await row();
    expect(message()).toBe("settings.about.forkUpdates.offline");
    expect(label()).toBe("check");

    fake.check.mockRejectedValue(new Error("Release manifest signature is invalid."));
    logs.length = 0;
    await row();
    expect(message()).toBe("settings.about.forkUpdates.failed");
    // The failure is logged with the state it happened in, before the new status.
    expect(logs).toEqual([
      "[paseo-agent] update status status=checking version=null",
      '[paseo-agent] update failed status=checking reason="Error: Release manifest signature is invalid."',
      "[paseo-agent] update status status=error version=null",
    ]);
  });

  it("keeps the last result when a background check fails", async () => {
    await backgroundCheck();
    fake.check.mockRejectedValue(new Error("offline"));
    logs.length = 0;
    await backgroundCheck();
    expect(message()).toBe('settings.about.forkUpdates.available {"version":"0.1.1"}');
    expect(logs).toEqual(['[paseo-agent] update failed status=checking reason="Error: offline"']);
  });

  it("reports progress against the current transfer's size, which sidecars shrink", async () => {
    await backgroundCheck();
    fake.download.mockReturnValue(new Promise(() => {}));
    void row();
    // Before the first progress event the APK's size stands in.
    expect(message()).toBe('settings.about.forkUpdates.downloadingProgress {"percent":0}');
    expect(view().icon).toEqual({ version: "0.1.1", downloading: true });
    fake.progress(50, 0);
    expect(message()).toBe('settings.about.forkUpdates.downloadingProgress {"percent":50}');
    fake.progress(20, 40);
    expect(message()).toBe('settings.about.forkUpdates.downloadingProgress {"percent":50}');
    // A failed delta falls back to a larger transfer, which restarts the count.
    fake.progress(10, 100);
    expect(message()).toBe('settings.about.forkUpdates.downloadingProgress {"percent":10}');
    expect(view().row.disabled).toBe(true);
  });

  it("restores a staged download and retries it after installer-return persistence fails", async () => {
    const { fake: staged, port } = createFakePort();
    staged.restoreStaged.mockResolvedValue({ update, path: APK, installedVersion: "0.1.0" });
    staged.recordInstalled.mockRejectedValueOnce(new Error("storage unavailable"));
    updater = createForkUpdateController(port, { shown: true });
    updater.start();
    await vi.waitFor(() =>
      expect(message()).toBe('settings.about.forkUpdates.downloaded {"version":"0.1.1"}'),
    );

    void row();
    await vi.waitFor(() => expect(staged.install).toHaveBeenCalledOnce());
    staged.installed = "0.1.1";
    staged.foreground();
    await vi.waitFor(() => expect(message()).toBe("settings.about.forkUpdates.failed"));
    expect(label()).toBe("install");
    expect(view().icon).not.toBeNull();
  });

  it("explains that a legacy installation requires manual migration", async () => {
    const { fake: legacy, port } = createFakePort();
    legacy.restoreStaged.mockRejectedValue(new ForkManualMigrationRequired());
    updater = createForkUpdateController(port, { shown: true });
    updater.start();
    await vi.waitFor(() =>
      expect(view().message).toMatchObject({
        key: "settings.about.forkUpdates.manualMigration",
        defaultValue: "Install the fork 0.1.0 or newer manually before using fork updates.",
      }),
    );
  });

  it("without the native module, shows a disabled failed row and ignores every input", async () => {
    updater = createForkUpdateController(null, { shown: true });
    const stop = updater.start();
    await backgroundCheck();
    await icon();
    await row();
    stop();
    expect(view()).toEqual({
      shown: true,
      enabled: false,
      message: { key: "settings.about.forkUpdates.failed" },
      row: { labelKey: "settings.about.forkUpdates.check", disabled: true },
      icon: null,
    });
    expect(createForkUpdateController(null, { shown: false }).views.getState().shown).toBe(false);
  });
});
