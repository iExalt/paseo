import { compareForkVersions } from "@getpaseo/protocol/fork-version";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import { create } from "zustand";
import {
  ForkManualMigrationRequired,
  canInstallForkUpdate,
  checkForForkUpdate,
  clearStagedForkUpdate,
  downloadForkUpdate,
  forkUpdatesNative,
  launchForkUpdateInstaller,
  openForkUpdateInstallSettings,
  recordInstalledForkUpdate,
  restoreStagedForkUpdate,
} from "./client";
import { isForkAndroidUpdaterEnabled, type VerifiedForkUpdate } from "./release";
import { agentLog, describeError } from "@/utils/agent-log";

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

interface ForkUpdateState {
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

const INITIAL_STATE: ForkUpdateState = {
  status: "idle",
  update: null,
  apkPath: null,
  installedVersion: null,
  downloadedBytes: 0,
  downloadTotalBytes: 0,
  failure: null,
};

// Module state, not component state: the result of a check outlives the About screen and
// feeds the sidebar update icon.
export const useForkUpdateStore = create<ForkUpdateState>(() => INITIAL_STATE);

useForkUpdateStore.subscribe((state, previous) => {
  if (state.status === previous.status) return;
  agentLog("update", "status", {
    status: state.status,
    version: state.update?.manifest.version ?? null,
    downloadedBytes: state.status === "downloaded" ? state.downloadedBytes : undefined,
  });
});

const setState = useForkUpdateStore.setState;
const getState = useForkUpdateStore.getState;

/** The row and icon render only in fork Android builds. */
export function isForkUpdaterShown(): boolean {
  return Platform.OS === "android" && Constants.expoConfig?.extra?.forkUpdatesEnabled === true;
}

export function isForkUpdaterEnabled(): boolean {
  return isForkAndroidUpdaterEnabled(
    Platform.OS,
    Constants.expoConfig?.extra?.forkUpdatesEnabled,
    forkUpdatesNative !== null,
  );
}

/** States the sidebar icon offers to continue from. */
export function hasPendingForkUpdate(state: ForkUpdateState): boolean {
  switch (state.status) {
    case "available":
    case "downloading":
    case "downloaded":
    case "permission":
    case "installing":
    case "canceled":
      return true;
    case "error":
      return state.apkPath !== null;
    default:
      return false;
  }
}

let beforeInstallerVersion: string | null = null;
let installerPending = false;
let permissionSettingsPending = false;

// Native fetches reject with the Java exception's name in the message; a JS fetch with this one.
const NETWORK_ERROR =
  /\b(?:UnknownHostException|ConnectException|NoRouteToHostException|SocketTimeoutException)\b|Network request failed/;

function fail(error: unknown): void {
  const reason = describeError(error);
  agentLog("update", "failed", { status: getState().status, reason });
  setState({
    status: error instanceof ForkManualMigrationRequired ? "migration-required" : "error",
    failure: NETWORK_ERROR.test(reason) ? "offline" : "release",
  });
}

async function reconcileInstallerReturn(): Promise<void> {
  const candidate = getState().update;
  if (!candidate || !forkUpdatesNative) return;
  const currentVersion = forkUpdatesNative.getInstalledVersion();
  setState({ installedVersion: currentVersion });
  if (
    currentVersion === candidate.manifest.version &&
    compareForkVersions(currentVersion, beforeInstallerVersion ?? currentVersion) > 0
  ) {
    await recordInstalledForkUpdate(candidate.manifest.version);
    setState({ status: "installed" });
    return;
  }
  if (compareForkVersions(currentVersion, candidate.manifest.version) > 0) {
    await clearStagedForkUpdate();
    setState({ status: "up-to-date" });
    return;
  }
  setState({ status: "canceled" });
}

function handleAppActive(): void {
  if (installerPending) {
    installerPending = false;
    void reconcileInstallerReturn().catch(fail);
  } else if (permissionSettingsPending) {
    permissionSettingsPending = false;
    void canInstallForkUpdate()
      .then((allowed) => setState({ status: allowed ? "downloaded" : "permission" }))
      .catch(fail);
  }
}

let listenerCount = 0;
let stopListeners: (() => void) | null = null;

/** Restores a downloaded update and follows installer returns; reference-counted. */
export function startForkUpdates(): () => void {
  const native = forkUpdatesNative;
  if (!native) return () => undefined;
  listenerCount += 1;
  if (listenerCount === 1) {
    const appState = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") handleAppActive();
    });
    const progress = native.addListener("onDownloadProgress", (event) => {
      setState({
        downloadedBytes: event.downloadedBytes,
        downloadTotalBytes: event.totalBytes,
      });
    });
    stopListeners = () => {
      appState.remove();
      progress.remove();
    };
    void restoreStagedForkUpdate()
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
    listenerCount -= 1;
    if (listenerCount === 0) {
      stopListeners?.();
      stopListeners = null;
    }
  };
}

// A background check must not interrupt a download, the installer or the permission screen.
function isUpdateInProgress(): boolean {
  const { status } = getState();
  return (
    status === "checking" ||
    status === "downloading" ||
    status === "installing" ||
    status === "permission"
  );
}

export async function checkForForkUpdateNow({
  userInitiated,
}: {
  userInitiated: boolean;
}): Promise<void> {
  if (!userInitiated && isUpdateInProgress()) return;
  const previousStatus = getState().status;
  if (userInitiated) setState({ status: "checking" });
  try {
    const result = await checkForForkUpdate();
    if (!userInitiated && isUpdateInProgress()) return;
    const current = getState();
    // Keep a verified download of the same release; a newer release replaces it.
    if (
      current.apkPath !== null &&
      result.update?.manifest.version === current.update?.manifest.version
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

export async function downloadPendingForkUpdate(): Promise<void> {
  const { update } = getState();
  if (!update) return;
  setState({ status: "downloading", downloadedBytes: 0, downloadTotalBytes: 0 });
  try {
    const path = await downloadForkUpdate(update);
    setState({ apkPath: path, status: "downloaded" });
  } catch (error) {
    fail(error);
  }
}

/** Installs the update without a confirmation where Android allows it; Paseo never asks. */
export async function installDownloadedForkUpdate(): Promise<void> {
  const { update, apkPath, installedVersion } = getState();
  if (!update || !apkPath) return;
  try {
    if (!(await canInstallForkUpdate())) {
      permissionSettingsPending = true;
      setState({ status: "permission" });
      await openForkUpdateInstallSettings();
      return;
    }
    beforeInstallerVersion = installedVersion;
    installerPending = true;
    setState({ status: "installing" });
    await launchForkUpdateInstaller(update, apkPath);
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

async function continueAfterPermission(): Promise<void> {
  try {
    if (await canInstallForkUpdate()) {
      setState({ status: "downloaded" });
      return;
    }
    permissionSettingsPending = true;
    await openForkUpdateInstallSettings();
  } catch (error) {
    fail(error);
  }
}

/** The About row's button: the next step for the current state. */
export async function runForkUpdateAction(): Promise<void> {
  const { status, apkPath } = getState();
  if (status === "available") {
    await downloadPendingForkUpdate();
  } else if (
    status === "downloaded" ||
    status === "canceled" ||
    (status === "error" && apkPath !== null)
  ) {
    await installDownloadedForkUpdate();
  } else if (status === "permission") {
    await continueAfterPermission();
  } else {
    await checkForForkUpdateNow({ userInitiated: true });
  }
}

/** The sidebar icon: download if needed, then open the installer. */
export async function updateToPendingForkRelease(): Promise<void> {
  const { status } = getState();
  if (status === "downloading" || status === "installing" || status === "checking") return;
  if (status === "available") {
    await downloadPendingForkUpdate();
    if (getState().status !== "downloaded") return;
  }
  if (getState().status === "permission") {
    await continueAfterPermission();
    if (getState().status !== "downloaded") return;
  }
  await installDownloadedForkUpdate();
}
