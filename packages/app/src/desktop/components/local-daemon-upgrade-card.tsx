import { daemonUpgradeForHost } from "@/desktop/daemon/daemon-upgrade-status";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { settingsStyles } from "@/styles/settings";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";

export function LocalDaemonUpgradeCard({
  serverId,
  status,
  managementEnabled,
  onRetry,
}: {
  serverId: string;
  status: DesktopDaemonStatus | null;
  managementEnabled: boolean;
  onRetry: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  // The old identity survives the intended stopped interval, but never a different live host.
  if (!status) return null;
  const upgrade = daemonUpgradeForHost(status, serverId, managementEnabled);
  if (status.serverId !== serverId && !upgrade) return null;
  if (!status.desktopManaged && !upgrade) return null;
  const phase = upgrade?.phase ?? "current";
  const version = formatVersionWithPrefix(status.version);
  const target = upgrade?.targetVersion ? formatVersionWithPrefix(upgrade.targetVersion) : null;

  return (
    <View style={settingsStyles.card} testID="host-daemon-upgrade" accessibilityLiveRegion="polite">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} testID="host-daemon-upgrade-status">
            {t(`desktop.daemon.upgrade.${phase}`)}
          </Text>
          <Text style={settingsStyles.rowHint}>{t(`desktop.daemon.upgrade.${phase}Hint`)}</Text>
          {upgrade?.error || retryError ? (
            <Text style={settingsStyles.rowHint}>{retryError ?? upgrade?.error}</Text>
          ) : null}
        </View>
        <Text style={settingsStyles.rowHint} testID="host-daemon-upgrade-version">
          {target ? `${version} → ${target}` : version}
        </Text>
      </View>
      {phase === "failed" ? (
        <View style={settingsStyles.row}>
          <Button
            variant="outline"
            size="sm"
            disabled={retrying}
            onPress={retry}
            testID="host-daemon-upgrade-retry"
          >
            {retrying ? t("desktop.daemon.upgrade.retrying") : t("desktop.daemon.upgrade.retry")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
