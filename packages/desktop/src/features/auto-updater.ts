import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { resolveDesktopInstallation } from "./nix-managed-install.js";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
type ElectronAutoUpdater = typeof import("electron-updater").autoUpdater;

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

const loadAutoUpdater = createElectronAutoUpdaterLoader({
  mode: DESKTOP_INSTALLATION.mode,
  load: () => import("electron-updater").then((module) => module.autoUpdater),
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

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  return shouldAdmitAppUpdate({ ...args, intent: "automatic" });
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
  // AppImage's no-relaunch install path blocks while launching the replacement
  // binary, which can hang after the running file has already been replaced.
  return !(input.platform === "linux" && input.isAppImage);
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoRunAppAfterInstall = true;
    // Paseo revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = input.releaseChannel === "beta";
    autoUpdater.channel = input.releaseChannel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await input.shouldAdmitUpdate(info as RuntimeUpdateInfo);
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
    try {
      const autoUpdater = await this.getConfiguredUpdater();
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo as RuntimeUpdateInfo,
      };
    } catch (error) {
      if (isUpdateChannelNotPublished(error)) return null;
      throw error;
    }
  }

  async downloadUpdate(targetVersion: string): Promise<unknown> {
    updateLifecycleLog.downloadRequested(targetVersion);
    const autoUpdater = await this.getConfiguredUpdater();
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall({ targetVersion, isSilent, isForceRunAfter }: AppUpdateInstallRequest): void {
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
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
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

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  assertElectronAutoUpdaterEnabled();
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
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
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  assertElectronAutoUpdaterEnabled();
  return appUpdateService.downloadAndInstallUpdate(
    { currentVersion, releaseChannel },
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
