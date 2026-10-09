import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import Constants from "expo-constants";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";
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
import { isForkAndroidUpdaterEnabled, type VerifiedForkUpdate } from "./release";

type UpdateStatus =
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
  | "error";

function getStatusMessage(
  t: TFunction,
  status: UpdateStatus,
  update: VerifiedForkUpdate | null,
  downloadedBytes: number,
): string {
  const version = update?.manifest.packageVersion;
  switch (status) {
    case "idle":
      return t("settings.about.forkUpdates.idle");
    case "checking":
      return t("settings.about.forkUpdates.checking");
    case "up-to-date":
      return t("settings.about.forkUpdates.current");
    case "available":
      return t("settings.about.forkUpdates.available", { version });
    case "downloading": {
      const totalBytes = update?.manifest.android.apk.bytes ?? 0;
      const percent =
        totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 0;
      return t("settings.about.forkUpdates.downloadingProgress", { percent });
    }
    case "downloaded":
      return t("settings.about.forkUpdates.downloaded", { version });
    case "permission":
      return t("settings.about.forkUpdates.permission");
    case "installing":
      return t("settings.about.forkUpdates.installer");
    case "installed":
      return t("settings.about.forkUpdates.installed", { version });
    case "canceled":
      return t("settings.about.forkUpdates.canceled");
    case "error":
      return t("settings.about.forkUpdates.failed");
  }
}

function getActionLabel(t: TFunction, status: UpdateStatus, hasStagedApk: boolean): string {
  switch (status) {
    case "checking":
      return t("settings.about.forkUpdates.checkingAction");
    case "downloading":
      return t("settings.about.forkUpdates.downloadingAction");
    case "available":
      return t("settings.about.forkUpdates.download");
    case "downloaded":
    case "canceled":
      return t("settings.about.forkUpdates.install");
    case "error":
      return t(
        hasStagedApk ? "settings.about.forkUpdates.install" : "settings.about.forkUpdates.check",
      );
    case "permission":
      return t("settings.about.forkUpdates.continue");
    default:
      return t("settings.about.forkUpdates.check");
  }
}

export function ForkAndroidUpdateRow() {
  const { t } = useTranslation();
  const enabled = isForkAndroidUpdaterEnabled(
    Platform.OS,
    Constants.expoConfig?.extra?.forkUpdatesEnabled,
    forkUpdatesNative !== null,
  );
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<VerifiedForkUpdate | null>(null);
  const [apkPath, setApkPath] = useState<string | null>(null);
  const [installedVersionCode, setInstalledVersionCode] = useState<number | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const updateRef = useRef(update);
  const beforeInstallerVersionRef = useRef<number | null>(null);
  const installerPendingRef = useRef(false);
  const permissionSettingsPendingRef = useRef(false);
  updateRef.current = update;

  const reconcileInstallerReturn = useCallback(async () => {
    const candidate = updateRef.current;
    if (!candidate || !forkUpdatesNative) return;
    const currentCode = forkUpdatesNative.getInstalledVersionCode();
    setInstalledVersionCode(currentCode);
    if (
      currentCode === candidate.manifest.android.versionCode &&
      currentCode > (beforeInstallerVersionRef.current ?? 0)
    ) {
      await recordInstalledForkUpdate(candidate.manifest.releaseSequence);
      setStatus("installed");
      return;
    }
    if (currentCode > candidate.manifest.android.versionCode) {
      await clearStagedForkUpdate();
      setStatus("up-to-date");
      return;
    }
    setStatus("canceled");
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      if (installerPendingRef.current) {
        installerPendingRef.current = false;
        void reconcileInstallerReturn().catch(() => setStatus("error"));
      } else if (permissionSettingsPendingRef.current) {
        permissionSettingsPendingRef.current = false;
        void canInstallForkUpdate()
          .then((allowed) => setStatus(allowed ? "downloaded" : "permission"))
          .catch(() => setStatus("error"));
      }
    });
    return () => subscription.remove();
  }, [reconcileInstallerReturn]);

  useEffect(() => {
    if (!forkUpdatesNative) return undefined;
    const subscription = forkUpdatesNative.addListener("onDownloadProgress", (event) => {
      setDownloadedBytes(event.downloadedBytes);
    });
    void restoreStagedForkUpdate()
      .then((staged) => {
        if (!staged) return undefined;
        setUpdate(staged.update);
        updateRef.current = staged.update;
        setApkPath(staged.path);
        setInstalledVersionCode(staged.installedVersionCode);
        setStatus("downloaded");
        setDownloadedBytes(staged.update.manifest.android.apk.bytes);
        return undefined;
      })
      .catch(() => setStatus("error"));
    return () => subscription.remove();
  }, []);

  const check = useCallback(async () => {
    setStatus("checking");
    try {
      const result = await checkForForkUpdate();
      setInstalledVersionCode(result.installedVersionCode);
      setUpdate(result.update);
      updateRef.current = result.update;
      setApkPath(null);
      setDownloadedBytes(0);
      setStatus(result.update ? "available" : "up-to-date");
    } catch {
      setStatus("error");
    }
  }, []);

  const download = useCallback(async () => {
    if (!update) return;
    setStatus("downloading");
    setDownloadedBytes(0);
    try {
      const path = await downloadForkUpdate(update);
      setApkPath(path);
      setStatus("downloaded");
    } catch {
      setStatus("error");
    }
  }, [update]);

  const openInstallFlow = useCallback(async () => {
    if (!update || !apkPath) return;
    try {
      const confirmed = await confirmDialog({
        title: t("settings.about.forkUpdates.installTitle"),
        message: t("settings.about.forkUpdates.installMessage"),
        confirmLabel: t("settings.about.forkUpdates.installConfirm"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!confirmed) return;
      if (!(await canInstallForkUpdate())) {
        permissionSettingsPendingRef.current = true;
        setStatus("permission");
        await openForkUpdateInstallSettings();
        return;
      }
      beforeInstallerVersionRef.current = installedVersionCode;
      installerPendingRef.current = true;
      setStatus("installing");
      await launchForkUpdateInstaller(update, apkPath);
    } catch {
      installerPendingRef.current = false;
      setStatus("error");
    }
  }, [apkPath, installedVersionCode, t, update]);

  const action = useCallback(() => {
    if (!enabled) return;
    if (status === "available") {
      void download();
    } else if (
      status === "downloaded" ||
      status === "canceled" ||
      (status === "error" && apkPath)
    ) {
      void openInstallFlow();
    } else if (status === "permission") {
      void canInstallForkUpdate()
        .then((allowed) => {
          if (allowed) {
            setStatus("downloaded");
            return undefined;
          } else {
            permissionSettingsPendingRef.current = true;
            return openForkUpdateInstallSettings();
          }
        })
        .catch(() => setStatus("error"));
    } else {
      void check();
    }
  }, [apkPath, check, download, enabled, openInstallFlow, status]);

  if (Platform.OS !== "android" || Constants.expoConfig?.extra?.forkUpdatesEnabled !== true) {
    return null;
  }

  const statusText = forkUpdatesNative
    ? getStatusMessage(t, status, update, downloadedBytes)
    : t("settings.about.forkUpdates.failed");
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const buttonLabel = getActionLabel(t, status, Boolean(apkPath));

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="fork-android-update-row">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.forkUpdates.label")}</Text>
        <Text style={settingsStyles.rowHint}>{statusText}</Text>
      </View>
      <Button variant="outline" size="sm" onPress={action} disabled={!enabled || busy}>
        {buttonLabel}
      </Button>
    </View>
  );
}
