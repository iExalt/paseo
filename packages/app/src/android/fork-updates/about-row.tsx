import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { forkUpdatesNative } from "./client";
import type { VerifiedForkUpdate } from "./release";
import {
  isForkUpdaterEnabled,
  isForkUpdaterShown,
  runForkUpdateAction,
  startForkUpdates,
  useForkUpdateStore,
  type ForkUpdateFailure,
  type ForkUpdateStatus,
} from "./store";

function getStatusMessage(
  t: TFunction,
  status: ForkUpdateStatus,
  update: VerifiedForkUpdate | null,
  downloadedBytes: number,
  downloadTotalBytes: number,
  failure: ForkUpdateFailure | null,
): string {
  const version = update?.manifest.version;
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
      const totalBytes = downloadTotalBytes || (update?.android.bytes ?? 0);
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
    case "migration-required":
      return t("settings.about.forkUpdates.manualMigration", {
        defaultValue: "Install the fork 0.1.0 or newer manually before using fork updates.",
      });
    case "error":
      if (failure === "offline") return t("settings.about.forkUpdates.offline");
      if (failure === "install") return t("settings.about.forkUpdates.installFailed");
      return t("settings.about.forkUpdates.failed");
  }
}

function getActionLabel(t: TFunction, status: ForkUpdateStatus, hasStagedApk: boolean): string {
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
  const enabled = isForkUpdaterEnabled();
  const status = useForkUpdateStore((state) => state.status);
  const update = useForkUpdateStore((state) => state.update);
  const apkPath = useForkUpdateStore((state) => state.apkPath);
  const downloadedBytes = useForkUpdateStore((state) => state.downloadedBytes);
  const downloadTotalBytes = useForkUpdateStore((state) => state.downloadTotalBytes);
  const failure = useForkUpdateStore((state) => state.failure);

  useEffect(() => startForkUpdates(), []);
  const onPress = useCallback(() => {
    if (enabled) void runForkUpdateAction();
  }, [enabled]);

  if (!isForkUpdaterShown()) {
    return null;
  }

  const statusText = forkUpdatesNative
    ? getStatusMessage(t, status, update, downloadedBytes, downloadTotalBytes, failure)
    : t("settings.about.forkUpdates.failed");
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const buttonLabel = getActionLabel(t, status, Boolean(apkPath));

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="fork-android-update-row">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.forkUpdates.label")}</Text>
        <Text style={settingsStyles.rowHint} testID="fork-android-update-status">
          {statusText}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={onPress}
        disabled={!enabled || busy}
        testID="fork-android-update-action"
      >
        {buttonLabel}
      </Button>
    </View>
  );
}
