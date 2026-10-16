import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { isFdroidBuild } from "@/constants/build-profile";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import {
  PUSH_CHANNEL_ID,
  reregisterPushToken,
  usePushRegistrationStore,
  type PushRegistrationStatus,
} from "@/push-notifications/registration";
import { useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";
import { resolveSoundSettingsTarget } from "./sound-settings";

const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

const STATUS_LABEL_KEYS: Record<PushRegistrationStatus, string> = {
  pending: "nativeNotifications.status.pending",
  sent: "nativeNotifications.status.sent",
  "not-connected": "nativeNotifications.status.notConnected",
  "no-permission": "nativeNotifications.status.noPermission",
  "no-token": "nativeNotifications.status.noToken",
  failed: "nativeNotifications.status.failed",
};

async function openSoundSettings(): Promise<void> {
  try {
    const channel =
      Platform.OS === "android"
        ? await Notifications.getNotificationChannelAsync(PUSH_CHANNEL_ID)
        : null;
    const target = resolveSoundSettingsTarget({
      platform: Platform.OS,
      packageName: Constants.expoConfig?.android?.package ?? null,
      channelExists: channel !== null,
    });
    if (target.kind === "channel") {
      await Linking.sendIntent(target.action, target.extras);
      return;
    }
  } catch (error) {
    console.warn("[Notifications] Failed to open channel settings", error);
  }
  await Linking.openSettings();
}

function HostRegistrationRow({ host, showBorder }: { host: HostProfile; showBorder: boolean }) {
  const { t } = useTranslation();
  const status = usePushRegistrationStore((state) => state[host.serverId]);
  const handleReregister = useCallback(() => reregisterPushToken(host.serverId), [host.serverId]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{host.label}</Text>
        <Text style={settingsStyles.rowHint}>
          {t(STATUS_LABEL_KEYS[status ?? "not-connected"])}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handleReregister}
        disabled={status === undefined || status === "pending"}
        testID={`push-registration-${host.serverId}`}
      >
        {t("nativeNotifications.reregister")}
      </Button>
    </View>
  );
}

export function NotificationsSection() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { snapshot, isRefreshing, requestingPermission, refreshPermissions, requestPermission } =
    useDesktopPermissions();

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);
  const handleRequestNotifications = useCallback(() => {
    void requestPermission("notifications");
  }, [requestPermission]);
  const handleOpenSoundSettings = useCallback(() => {
    void openSoundSettings();
  }, []);

  const refreshIcon = useMemo(() => <ThemedRotateCw />, []);
  const isBusy = isRefreshing || requestingPermission !== null;
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isBusy}
        accessibilityLabel={t("settings.notifications.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [handleRefreshPress, isBusy, isRefreshing, refreshIcon, t],
  );
  const permissionLabels = useMemo(
    () => ({
      granted: t("settings.permissions.actions.granted"),
      request: t("settings.permissions.actions.request"),
      requesting: t("settings.permissions.actions.requesting"),
      openSettings: t("nativePermissions.openSettings"),
    }),
    [t],
  );

  return (
    <>
      <SettingsSection title={t("settings.notifications.title")} trailing={refreshButton}>
        <View style={settingsStyles.card}>
          <DesktopPermissionRow
            title={t("settings.notifications.permission")}
            status={snapshot?.notifications ?? null}
            isRequesting={requestingPermission === "notifications"}
            onRequest={handleRequestNotifications}
            labels={permissionLabels}
          />
          {isFdroidBuild ? null : (
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{t("nativeNotifications.sound")}</Text>
                <Text style={settingsStyles.rowHint}>{t("nativeNotifications.soundHint")}</Text>
              </View>
              <Button
                variant="outline"
                size="sm"
                onPress={handleOpenSoundSettings}
                testID="notifications-sound-settings"
              >
                {t("nativeNotifications.open")}
              </Button>
            </View>
          )}
        </View>
      </SettingsSection>
      {isFdroidBuild || hosts.length === 0 ? null : (
        <SettingsSection title={t("nativeNotifications.hostsTitle")}>
          <Text style={settingsStyles.rowHint}>{t("nativeNotifications.hostsHint")}</Text>
          <View style={settingsStyles.card}>
            {hosts.map((host, index) => (
              <HostRegistrationRow key={host.serverId} host={host} showBorder={index > 0} />
            ))}
          </View>
        </SettingsSection>
      )}
    </>
  );
}
