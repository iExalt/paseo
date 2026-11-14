import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { resolveDesktopInstallation } from "./nix-managed-install.js";
import {
  createAppUpdateService,
  type BeforeUpdateQuit,
  type AppUpdateCheckResult,
  type AppUpdateDownloadProgress,
  type AppUpdateInstallLaunchResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeDownloadProgressInfo,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import { createAppUpdatePacing } from "./app-update-pacing.js";
import {
  rolloutBucket,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateDownloadProgress,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

type ElectronAutoUpdater = import("./windows-fork-updater.js").ForkNsisUpdater;

const DESKTOP_INSTALLATION = resolveDesktopInstallation(process.resourcesPath);

export function assertElectronAutoUpdaterEnabled(mode = DESKTOP_INSTALLATION.mode): void {
  if (mode !== "electron") {
    throw new Error("Electron updates are disabled for Nix-managed desktop installations.");
  }
}

export function createElectronAutoUpdaterLoader<T>(input: {
  mode: "electron" | "nix" | "nix-invalid";
  load: () => Promise<T>;
}): () => Promise<T> {
  let updaterPromise: Promise<T> | null = null;
  return () => {
    if (input.mode !== "electron") {
      return Promise.reject(
        new Error("electron-updater is disabled for Nix-managed desktop installations."),
      );
    }
    updaterPromise ??= input.load();
    return updaterPromise;
  };
}

let prepareForkInstall: ((version: string) => Promise<void>) | null = null;

const loadAutoUpdater = createElectronAutoUpdaterLoader({
  mode: DESKTOP_INSTALLATION.mode,
  load: async () => {
    const { ForkNsisUpdater, configureForkWindowsUpdater } =
      await import("./windows-fork-updater.js");
    const autoUpdater = new ForkNsisUpdater();
    prepareForkInstall = configureForkWindowsUpdater(autoUpdater, {
      platform: process.platform,
      arch: process.arch,
      stateDirectory: app.getPath("userData"),
      runningVersion: app.getVersion(),
    });
    return autoUpdater;
  },
});

function loadElectronAutoUpdater(): Promise<ElectronAutoUpdater> {
  return loadAutoUpdater();
}

export async function registerBeforeQuitForUpdate(handler: () => void): Promise<void> {
  assertElectronAutoUpdaterEnabled();
  const { autoUpdater } = await import("electron");
  autoUpdater.on("before-quit-for-update", handler);
}

interface AppUpdateLogSink {
  info(message: string, details: object): void;
}

interface AppUpdateCheckLogDetails {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}

interface AppUpdateCheckCompletedLogDetails extends AppUpdateCheckLogDetails {
  targetVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  errorMessage: string | null;
}

export function createAppUpdateLifecycleLogger(logger: AppUpdateLogSink) {
  return {
    checkStarted(details: AppUpdateCheckLogDetails): void {
      logger.info("[auto-updater] check started", details);
    },
    checkCompleted(details: AppUpdateCheckCompletedLogDetails): void {
      logger.info("[auto-updater] check completed", details);
    },
    updateAvailable(targetVersion: string): void {
      logger.info("[auto-updater] update available", { targetVersion });
    },
    updateDownloaded(targetVersion: string): void {
      logger.info("[auto-updater] update downloaded", { targetVersion });
    },
    downloadRequested(targetVersion: string): void {
      logger.info("[auto-updater] download requested", { targetVersion });
    },
    quitAndInstallRequested(details: AppUpdateInstallRequest): void {
      logger.info("[auto-updater] quitAndInstall requested", details);
    },
  };
}

const updateLifecycleLog = createAppUpdateLifecycleLogger(log);
const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export async function resolveStagingUserId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, "utf8")).trim();
    if (UUID.check(id)) {
      return id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-updater] Couldn't read staging user ID, creating a blank one: ${error}`);
    }
  }

  const id = UUID.v5(randomBytes(4096), UUID.OID);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, id);
  } catch (error) {
    console.warn(`[auto-updater] Couldn't write out staging user ID: ${error}`);
  }

  return id;
}

export function getStagingUserId(): Promise<string> {
  if (cachedStagingUserIdPromise == null) {
    cachedStagingUserIdPromise = resolveStagingUserId(
      path.join(app.getPath("userData"), ".updaterId"),
    );
  }
  return cachedStagingUserIdPromise;
}

export function shouldInstallAppUpdateOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  // Fork updates apply explicitly after the platform safety gate.
  void input;
  return false;
}

const APP_UPDATE_DOWNLOAD_PROGRESS_EVENT = "paseo:event:app-update-download-progress";
const activeProgressBarWindows = new WeakSet<BrowserWindow>();

// macOS 26 Intel under Electron 44 wedges the main process and leaks gigabytes of
// IOSurfaces in VizCompositorThread when BrowserWindow.setProgressBar() touches the
// Dock tile. In-app download progress still updates via APP_UPDATE_DOWNLOAD_PROGRESS_EVENT.
export function shouldUseWindowProgressBar(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

function resolveProgressBarValue(progress: AppUpdateDownloadProgress | null): number {
  if (progress === null) return -1;
  if (!Number.isFinite(progress.percent)) return 0;
  return Math.max(0, Math.min(1, progress.percent / 100));
}

function broadcastDownloadProgress(progress: AppUpdateDownloadProgress | null): void {
  const normalizedBar = resolveProgressBarValue(progress);
  const useWindowProgressBar = shouldUseWindowProgressBar(process.platform);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const shouldUpdateProgressBar =
      useWindowProgressBar && (progress !== null || activeProgressBarWindows.has(win));
    if (shouldUpdateProgressBar) {
      try {
        win.setProgressBar(normalizedBar);
        if (progress === null) {
          activeProgressBarWindows.delete(win);
        } else {
          activeProgressBarWindows.add(win);
        }
      } catch {
        // Progress bar support is optional across desktop environments.
      }
    }
    try {
      win.webContents.send(APP_UPDATE_DOWNLOAD_PROGRESS_EVENT, progress);
    } catch {
      // Window may be tearing down during quitAndInstall.
    }
  }
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configuration: AppUpdateRuntimeConfiguration | null = null;
  private configuredPromise: Promise<ElectronAutoUpdater> | null = null;
  private autoUpdater: ElectronAutoUpdater | null = null;

  configure(input: AppUpdateRuntimeConfiguration): void {
    this.configuration = input;
    if (!this.configuredPromise) {
      this.configuredPromise = loadElectronAutoUpdater().then((autoUpdater) => {
        this.autoUpdater = autoUpdater;
        this.applyConfiguration(autoUpdater);
        return autoUpdater;
      });
    } else if (this.autoUpdater) {
      this.applyConfiguration(this.autoUpdater);
    }
  }

  private applyConfiguration(autoUpdater: ElectronAutoUpdater): void {
    const input = this.configuration;
    if (!input) return;
    autoUpdater.autoDownload = input.autoDownload;
    autoUpdater.autoRunAppAfterInstall = true;
    // Paseo revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await (this.configuration?.shouldAdmitUpdate(info as RuntimeUpdateInfo) ?? true);
      } catch {
        return true;
      }
    };

    if (this.listenersConfigured) return;
    this.listenersConfigured = true;

    // electron-updater logs every emitted error before consumers can classify it.
    // Paseo reports genuine check, runtime, and install failures through the
    // callbacks below, so leave internal error logging disabled to avoid both
    // duplicate logs and expected missing-channel noise.
    const updaterLogger = autoUpdater.logger;
    autoUpdater.logger = {
      debug: updaterLogger?.debug ? (message) => updaterLogger.debug?.(message) : undefined,
      error: () => undefined,
      info: (message) => updaterLogger?.info(message),
      warn: (message) => updaterLogger?.warn(message),
    };

    autoUpdater.on("update-available", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateAvailable(updateInfo.version);
      this.configuration?.onUpdateAvailable(updateInfo);
    });
    autoUpdater.on("download-progress", (progress) => {
      this.configuration?.onDownloadProgress(progress as RuntimeDownloadProgressInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateDownloaded(updateInfo.version);
      this.configuration?.onUpdateDownloaded(updateInfo);
    });
    autoUpdater.on("error", (error) => {
      if (isUpdateChannelNotPublished(error)) return;
      this.configuration?.onError(error);
    });
  }

  setAutoDownload(enabled: boolean): void {
    if (this.configuration) this.configuration.autoDownload = enabled;
    if (this.autoUpdater) this.autoUpdater.autoDownload = enabled;
  }

  private listenersConfigured = false;

  private async getConfiguredUpdater(): Promise<ElectronAutoUpdater> {
    if (!this.configuredPromise) {
      throw new Error("The Electron updater has not been configured.");
    }
    const autoUpdater = await this.configuredPromise;
    if (this.autoUpdater) this.applyConfiguration(autoUpdater);
    return autoUpdater;
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    const autoUpdater = await this.getConfiguredUpdater();
    const result = await autoUpdater.checkForUpdates();
    if (!result) return null;
    // Download failures are surfaced by the error event; also consume the rejected promise.
    void result.downloadPromise?.catch(() => undefined);
    return {
      isUpdateAvailable: result.isUpdateAvailable,
      updateInfo: result.updateInfo as RuntimeUpdateInfo,
    };
  }

  async downloadUpdate(targetVersion: string): Promise<unknown> {
    updateLifecycleLog.downloadRequested(targetVersion);
    const autoUpdater = await this.getConfiguredUpdater();
    return autoUpdater.downloadUpdate();
  }

  async prepareInstall(targetVersion: string): Promise<void> {
    await this.getConfiguredUpdater();
    if (!prepareForkInstall) throw new Error("Fork updater is not configured.");
    await prepareForkInstall(targetVersion);
  }

  async quitAndInstall({
    targetVersion,
    isSilent,
    isForceRunAfter,
  }: AppUpdateInstallRequest): Promise<AppUpdateInstallLaunchResult> {
    broadcastDownloadProgress(null);
    if (!this.autoUpdater) {
      throw new Error("The Electron updater is unavailable for this installation.");
    }
    const autoUpdater = this.autoUpdater;
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested({
      targetVersion,
      isSilent,
      isForceRunAfter,
    });
    await autoUpdater.launchForkInstaller(isSilent, isForceRunAfter);
    const { autoUpdater: nativeUpdater } = await import("electron");
    nativeUpdater.emit("before-quit-for-update");
    app.quit();
    return { started: true };
  }
}

const appUpdatePacing = createAppUpdatePacing({
  filePath: () => path.join(app.getPath("userData"), "app-update-pacing.json"),
  currentVersion: () => app.getVersion(),
  now: () => Date.now(),
  reportError: (error) => {
    console.warn("[auto-updater] Update pacing state is unavailable, not pacing updates:", error);
  },
});

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async (version) => rolloutBucket(await getStagingUserId(), version),
  pacing: appUpdatePacing,
  updateMode: async () => (await getDesktopSettingsStore().get()).updates.mode,
  onDownloadProgress: broadcastDownloadProgress,
  reportSettingsError: (error) => {
    console.warn(
      "[auto-updater] Failed to read desktop update mode, defaulting to automatic:",
      error,
    );
  },
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
  },
  reportAdmissionError: (error) => {
    console.warn("[auto-updater] Failed to place this install in the rollout, admitting:", error);
  },
  reportRuntimeError: (error) => {
    console.error("[auto-updater] Updater event failed:", error);
  },
  reportInstallError: (message) => {
    console.error("[auto-updater] Failed to download/install update:", message);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notes the running version, so the launch that follows an update starts the
 * update cooldown. Call once when the app is ready. Never rejects.
 */
export function startAppUpdatePacing(): Promise<void> {
  if (DESKTOP_INSTALLATION.mode !== "electron" || !app.isPackaged) return Promise.resolve();
  return appUpdatePacing.start();
}

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
  autoDownload,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
  autoDownload?: boolean;
}): Promise<AppUpdateCheckResult> {
  assertElectronAutoUpdaterEnabled();
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel: "stable",
    intent,
    autoDownload,
  });
  updateLifecycleLog.checkCompleted({
    currentVersion,
    targetVersion: result.latestVersion,
    releaseChannel,
    intent,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function downloadAndInstallUpdate(
  {
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  },
  onBeforeQuit?: BeforeUpdateQuit,
): Promise<AppUpdateInstallResult> {
  assertElectronAutoUpdaterEnabled();
  void releaseChannel;
  return appUpdateService.downloadAndInstallUpdate(
    { currentVersion, releaseChannel: "stable" },
    onBeforeQuit,
  );
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
}): Promise<boolean> {
  assertElectronAutoUpdaterEnabled();
  if (
    !shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    })
  ) {
    return false;
  }

  return appUpdateService.installUpdateOnQuit({ currentVersion, releaseChannel, signal });
}
