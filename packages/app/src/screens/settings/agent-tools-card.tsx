import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useAgentToolsSetting } from "@/hooks/use-agent-tools-setting";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

export function AgentToolsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { enabled, setEnabled } = useAgentToolsSetting(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      void setEnabled(next);
    },
    [setEnabled],
  );

  if (!isConnected || enabled === null) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-agent-tools-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.orchestration.enableTools.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.orchestration.enableTools.hint")}
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={handleValueChange}
          accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
          testID="host-page-agent-tools-switch"
        />
      </View>
    </View>
  );
}
