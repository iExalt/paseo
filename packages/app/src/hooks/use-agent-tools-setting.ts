import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export function useAgentToolsSetting(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!client) return () => {};
      const stopGet = client.on("get_daemon_config_response", notify);
      const stopSet = client.on("set_daemon_config_response", notify);
      return () => {
        stopGet();
        stopSet();
      };
    },
    [client],
  );
  const getField = useCallback(() => client?.getAgentToolsConfigField() ?? null, [client]);
  const field = useSyncExternalStore(subscribe, getField, getField);
  const enabled = field !== null && config ? config.agentTools.enabled : null;

  const setEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      try {
        // A reconnect may have replaced the config since the switch rendered.
        const currentField = getField();
        if (currentField !== null && currentField === field) {
          const patch =
            currentField === "agentTools"
              ? { agentTools: { enabled: next } }
              : { mcp: { injectIntoAgents: next } };
          const result = await patchConfig(patch);
          if (getField() === currentField && result?.agentTools.enabled === next) return true;
        }
      } catch {
        // Permission or transport errors must not retry through a different setting.
      }
      toast.error(t("settings.host.orchestration.enableTools.updateFailed"));
      return false;
    },
    [field, getField, patchConfig, t, toast],
  );

  return { enabled, setEnabled };
}
