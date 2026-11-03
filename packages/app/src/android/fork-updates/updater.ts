import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import { useStore } from "zustand";
import {
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
import { createForkUpdateController, type ForkUpdatePort, type ForkUpdateView } from "./controller";
import { isForkAndroidUpdaterEnabled } from "./release";

// Wires the fork updater controller to the Kotlin module and Android's app state.
// The app has one controller: a found update outlives the About screen and feeds
// the sidebar icon.

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

function nativePort(): ForkUpdatePort | null {
  const native = forkUpdatesNative;
  if (!native) return null;
  return {
    installedVersion: () => native.getInstalledVersion(),
    check: checkForForkUpdate,
    download: downloadForkUpdate,
    restoreStaged: restoreStagedForkUpdate,
    canInstall: canInstallForkUpdate,
    openInstallSettings: openForkUpdateInstallSettings,
    install: launchForkUpdateInstaller,
    recordInstalled: recordInstalledForkUpdate,
    clearStaged: clearStagedForkUpdate,
    watch({ foreground, progress }) {
      const appState = AppState.addEventListener("change", (next) => {
        if (next === "active") foreground();
      });
      const downloads = native.addListener("onDownloadProgress", (event) =>
        progress(event.downloadedBytes, event.totalBytes),
      );
      return () => {
        appState.remove();
        downloads.remove();
      };
    },
  };
}

export const forkUpdater = createForkUpdateController(nativePort(), {
  shown: isForkUpdaterShown(),
});

/** Select only what you render: download progress changes the view many times a second. */
export function useForkUpdate<T>(selector: (view: ForkUpdateView) => T): T {
  return useStore(forkUpdater.views, selector);
}
