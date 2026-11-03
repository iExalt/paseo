import { compareForkVersions } from "@getpaseo/protocol/fork-version";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ForkManualMigrationRequired, type VerifiedForkUpdate } from "./release";
import { agentLog, describeError } from "@/utils/agent-log";

// The fork updater controller: one state machine for the About row, the sidebar
// icon and the hourly check. Callers render its view and send it inputs; the
// native updater, Android's installer and the foreground signal sit behind
// ForkUpdatePort. Nothing here imports React Native, Expo or the native client.

export const FORK_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type ForkUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "permission"
  | "installing"
  | "installed"
  | "canceled"
  | "error"
  | "migration-required";

export type ForkUpdateFailure = "offline" | "release" | "install";

export interface StagedForkUpdate {
  update: VerifiedForkUpdate;
  path: string;
  installedVersion: string;
}

/** The native updater; client.ts in the app, an in-memory fake in tests. */
export interface ForkUpdatePort {
  installedVersion(): string;
  check(): Promise<{ update: VerifiedForkUpdate | null; installedVersion: string }>;
  download(update: VerifiedForkUpdate): Promise<string>;
  restoreStaged(): Promise<StagedForkUpdate | null>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  /** Resolves when the user cancels; a successful update replaces the app process. */
  install(update: VerifiedForkUpdate, path: string): Promise<void>;
  recordInstalled(version: string): Promise<void>;
  clearStaged(): Promise<void>;
  /** Starts delivering foreground returns and download progress; returns the stop. */
  watch(events: {
    foreground(): void;
    progress(downloadedBytes: number, totalBytes: number): void;
  }): () => void;
}

export type ForkUpdateInput = { type: "press"; via: "row" | "icon" } | { type: "check" };

export interface ForkUpdateText {
  key: string;
  params?: Record<string, unknown>;
  defaultValue?: string;
}

export interface ForkUpdateView {
  /** The row and icon exist only in fork Android builds. */
  shown: boolean;
  /** The native updater is present; without it the row shows a failure and stays disabled. */
  enabled: boolean;
  /** The About row's status line. */
  message: ForkUpdateText;
  /** The About row's button. */
  row: { labelKey: string; disabled: boolean };
  /** The sidebar icon, or null to hide it. */
  icon: { version: string | null; downloading: boolean } | null;
}

export interface ForkUpdateController {
  /** The view as a store, so renderers can select only what they draw. */
  views: Pick<StoreApi<ForkUpdateView>, "getState" | "getInitialState" | "subscribe">;
  /** Restores a downloaded update and follows installer returns; reference-counted. */
  start(): () => void;
  /** A press runs the next step for the current state; a check never interrupts one. Never rejects. */
  send(input: ForkUpdateInput): Promise<void>;
}

interface State {
  status: ForkUpdateStatus;
  update: VerifiedForkUpdate | null;
  apkPath: string | null;
  installedVersion: string | null;
  downloadedBytes: number;
  // The transfer size the native download reports; the `.gz` sidecar is smaller than the
  // APK. 0 until the first progress event.
  downloadTotalBytes: number;
  // What the last error was: GitHub unreachable, a release failing its checks, or Android
  // refusing the verified APK.
  failure: ForkUpdateFailure | null;
}

const INITIAL_STATE: State = {
  status: "idle",
  update: null,
  apkPath: null,
  installedVersion: null,
  downloadedBytes: 0,
  downloadTotalBytes: 0,
  failure: null,
};

// Native fetches reject with the Java exception's name in the message; a JS fetch with this one.
const NETWORK_ERROR =
  /\b(?:UnknownHostException|ConnectException|NoRouteToHostException|SocketTimeoutException)\b|Network request failed/;

// Three different questions, kept apart on purpose: the permission screen holds off a
// background check and keeps the icon, but its row button stays pressable.
/** A failed step that left a verified download behind offers to install it again. */
function canRetryStagedInstall({ status, apkPath }: State): boolean {
  return status === "error" && apkPath !== null;
}

/** States the sidebar icon offers to continue from. */
function isPending(state: State): boolean {
  switch (state.status) {
    case "available":
    case "downloading":
    case "downloaded":
    case "permission":
    case "installing":
    case "canceled":
      return true;
    case "error":
      return canRetryStagedInstall(state);
    default:
      return false;
  }
}

/** A background check must not interrupt a download, the installer or the permission screen. */
function isUpdateInProgress({ status }: State): boolean {
  return (
    status === "checking" ||
    status === "downloading" ||
    status === "installing" ||
    status === "permission"
  );
}

/** The row button waits out work the app is doing itself. */
function isRowBusy({ status }: State): boolean {
  return status === "checking" || status === "downloading" || status === "installing";
}

const KEY = "settings.about.forkUpdates";

function messageOf(state: State): ForkUpdateText {
  const version = state.update?.manifest.version;
  switch (state.status) {
    case "idle":
      return { key: `${KEY}.idle` };
    case "checking":
      return { key: `${KEY}.checking` };
    case "up-to-date":
      return { key: `${KEY}.current` };
    case "available":
      return { key: `${KEY}.available`, params: { version } };
    case "downloading": {
      const totalBytes = state.downloadTotalBytes || (state.update?.android.bytes ?? 0);
      const percent =
        totalBytes > 0 ? Math.min(100, Math.floor((state.downloadedBytes / totalBytes) * 100)) : 0;
      return { key: `${KEY}.downloadingProgress`, params: { percent } };
    }
    case "downloaded":
      return { key: `${KEY}.downloaded`, params: { version } };
    case "permission":
      return { key: `${KEY}.permission` };
    case "installing":
      return { key: `${KEY}.installer` };
    case "installed":
      return { key: `${KEY}.installed`, params: { version } };
    case "canceled":
      return { key: `${KEY}.canceled` };
    case "migration-required":
      return {
        key: `${KEY}.manualMigration`,
        defaultValue: "Install the fork 0.1.0 or newer manually before using fork updates.",
      };
    case "error":
      if (state.failure === "offline") return { key: `${KEY}.offline` };
      if (state.failure === "install") return { key: `${KEY}.installFailed` };
      return { key: `${KEY}.failed` };
  }
}

function rowLabelKeyOf(state: State): string {
  switch (state.status) {
    case "checking":
      return `${KEY}.checkingAction`;
    case "downloading":
      return `${KEY}.downloadingAction`;
    case "available":
      return `${KEY}.download`;
    case "downloaded":
    case "canceled":
      return `${KEY}.install`;
    case "error":
      return canRetryStagedInstall(state) ? `${KEY}.install` : `${KEY}.check`;
    case "permission":
      return `${KEY}.continue`;
    default:
      return `${KEY}.check`;
  }
}

function viewOf(state: State, shown: boolean, enabled: boolean): ForkUpdateView {
  return {
    shown,
    enabled,
    message: enabled ? messageOf(state) : { key: `${KEY}.failed` },
    row: { labelKey: rowLabelKeyOf(state), disabled: !enabled || isRowBusy(state) },
    icon:
      shown && isPending(state)
        ? {
            version: state.update?.manifest.version ?? null,
            downloading: state.status === "downloading",
          }
        : null,
  };
}

export function createForkUpdateController(
  port: ForkUpdatePort | null,
  { shown }: { shown: boolean },
): ForkUpdateController {
  const enabled = shown && port !== null;
  let state = INITIAL_STATE;
  const views = createStore<ForkUpdateView>(() => viewOf(state, shown, enabled));

  // Installer-return memory: what the app has handed to Android and is waiting on.
  let beforeInstallerVersion: string | null = null;
  let installerPending = false;
  let permissionSettingsPending = false;
  let startCount = 0;
  let stopWatching: (() => void) | null = null;

  function setState(patch: Partial<State>): void {
    const previous = state;
    state = { ...state, ...patch };
    if (state.status !== previous.status) {
      agentLog("update", "status", {
        status: state.status,
        version: state.update?.manifest.version ?? null,
        downloadedBytes: state.status === "downloaded" ? state.downloadedBytes : undefined,
      });
    }
    views.setState(viewOf(state, shown, enabled), true);
  }

  function fail(error: unknown): void {
    const reason = describeError(error);
    agentLog("update", "failed", { status: state.status, reason });
    setState({
      status: error instanceof ForkManualMigrationRequired ? "migration-required" : "error",
      failure: NETWORK_ERROR.test(reason) ? "offline" : "release",
    });
  }

  async function reconcileInstallerReturn(native: ForkUpdatePort): Promise<void> {
    const candidate = state.update;
    if (!candidate) return;
    const currentVersion = native.installedVersion();
    setState({ installedVersion: currentVersion });
    if (
      currentVersion === candidate.manifest.version &&
      compareForkVersions(currentVersion, beforeInstallerVersion ?? currentVersion) > 0
    ) {
      await native.recordInstalled(candidate.manifest.version);
      setState({ status: "installed" });
      return;
    }
    if (compareForkVersions(currentVersion, candidate.manifest.version) > 0) {
      await native.clearStaged();
      setState({ status: "up-to-date" });
      return;
    }
    setState({ status: "canceled" });
  }

  function onForeground(native: ForkUpdatePort): void {
    if (installerPending) {
      installerPending = false;
      void reconcileInstallerReturn(native).catch(fail);
    } else if (permissionSettingsPending) {
      permissionSettingsPending = false;
      void native
        .canInstall()
        .then((allowed) => setState({ status: allowed ? "downloaded" : "permission" }))
        .catch(fail);
    }
  }

  async function check(native: ForkUpdatePort, userInitiated: boolean): Promise<void> {
    if (!userInitiated && isUpdateInProgress(state)) return;
    const previousStatus = state.status;
    if (userInitiated) setState({ status: "checking" });
    try {
      const result = await native.check();
      if (!userInitiated && isUpdateInProgress(state)) return;
      // Keep a verified download of the same release; a newer release replaces it.
      if (
        state.apkPath !== null &&
        result.update?.manifest.version === state.update?.manifest.version
      ) {
        setState({
          installedVersion: result.installedVersion,
          status: userInitiated ? "downloaded" : previousStatus,
        });
        return;
      }
      setState({
        installedVersion: result.installedVersion,
        update: result.update,
        apkPath: null,
        downloadedBytes: 0,
        status: result.update ? "available" : "up-to-date",
      });
    } catch (error) {
      // A failed background check keeps the last good result.
      if (userInitiated) fail(error);
      else agentLog("update", "failed", { status: "checking", reason: describeError(error) });
    }
  }

  async function download(native: ForkUpdatePort): Promise<void> {
    const { update } = state;
    if (!update) return;
    setState({ status: "downloading", downloadedBytes: 0, downloadTotalBytes: 0 });
    try {
      const path = await native.download(update);
      setState({ apkPath: path, status: "downloaded" });
    } catch (error) {
      fail(error);
    }
  }

  /** Installs the update without a confirmation where Android allows it; Paseo never asks. */
  async function install(native: ForkUpdatePort): Promise<void> {
    const { update, apkPath, installedVersion } = state;
    if (!update || !apkPath) return;
    try {
      if (!(await native.canInstall())) {
        permissionSettingsPending = true;
        setState({ status: "permission" });
        await native.openInstallSettings();
        return;
      }
      beforeInstallerVersion = installedVersion;
      installerPending = true;
      setState({ status: "installing" });
      await native.install(update, apkPath);
      // Reaching here means the user canceled Android's confirmation.
      if (installerPending) {
        installerPending = false;
        setState({ status: "canceled" });
      }
    } catch (error) {
      installerPending = false;
      agentLog("update", "failed", { status: "installing", reason: describeError(error) });
      setState({ status: "error", failure: "install" });
    }
  }

  async function continueAfterPermission(native: ForkUpdatePort): Promise<void> {
    try {
      if (await native.canInstall()) {
        setState({ status: "downloaded" });
        return;
      }
      permissionSettingsPending = true;
      await native.openInstallSettings();
    } catch (error) {
      fail(error);
    }
  }

  /** The About row's button: the next step for the current state. */
  async function pressRow(native: ForkUpdatePort): Promise<void> {
    const { status } = state;
    if (status === "available") {
      await download(native);
    } else if (status === "downloaded" || status === "canceled" || canRetryStagedInstall(state)) {
      await install(native);
    } else if (status === "permission") {
      await continueAfterPermission(native);
    } else {
      await check(native, true);
    }
  }

  // Read after an await: the step may have moved the state on.
  const currentStatus = (): ForkUpdateStatus => state.status;

  /** The sidebar icon: download if needed, then open the installer. */
  async function pressIcon(native: ForkUpdatePort): Promise<void> {
    const { status } = state;
    if (status === "downloading" || status === "installing" || status === "checking") return;
    if (status === "available") {
      await download(native);
      if (currentStatus() !== "downloaded") return;
    }
    if (currentStatus() === "permission") {
      await continueAfterPermission(native);
      if (currentStatus() !== "downloaded") return;
    }
    await install(native);
  }

  return {
    views: {
      getState: views.getState,
      getInitialState: views.getInitialState,
      subscribe: views.subscribe,
    },
    start() {
      const native = port;
      if (!native) return () => undefined;
      startCount += 1;
      if (startCount === 1) {
        stopWatching = native.watch({
          foreground: () => onForeground(native),
          progress: (downloadedBytes, downloadTotalBytes) =>
            setState({ downloadedBytes, downloadTotalBytes }),
        });
        void native
          .restoreStaged()
          .then((staged) => {
            if (!staged) return undefined;
            setState({
              update: staged.update,
              apkPath: staged.path,
              installedVersion: staged.installedVersion,
              status: "downloaded",
              downloadedBytes: staged.update.android.bytes,
            });
            return undefined;
          })
          .catch(fail);
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        startCount -= 1;
        if (startCount === 0) {
          stopWatching?.();
          stopWatching = null;
        }
      };
    },
    async send(input) {
      const native = port;
      if (!native) return;
      if (input.type === "check") await check(native, false);
      else if (input.via === "row") await pressRow(native);
      else await pressIcon(native);
    },
  };
}
