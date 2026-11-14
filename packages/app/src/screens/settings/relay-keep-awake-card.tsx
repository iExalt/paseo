import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

export function RelayKeepAwakeCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.relayKeepAwake === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({ relay: { keepAwake: next } }).catch((error) => {
        console.error("[HostPage] Failed to update relay keep-awake", error);
        Alert.alert(
          t("settings.host.pairDevices.keepAwake.updateFailed"),
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, t],
  );

  if (!isConnected || !supported) return null;

  const keepAwake = config?.relay?.keepAwake === true;
  const relayEnabled = config?.relay?.enabled === true;
  let hint = t("settings.host.pairDevices.keepAwake.hint");
  if (keepAwake) {
    hint = relayEnabled
      ? t("settings.host.pairDevices.keepAwake.activeHint")
      : t("settings.host.pairDevices.keepAwake.waitingHint");
  }

  return (
    <View style={settingsStyles.card} testID="host-page-relay-keep-awake-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.pairDevices.keepAwake.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>{hint}</Text>
        </View>
        <Switch
          value={keepAwake}
          onValueChange={handleValueChange}
          accessibilityLabel={t("settings.host.pairDevices.keepAwake.title")}
          testID="host-page-relay-keep-awake-switch"
        />
      </View>
    </View>
  );
}
