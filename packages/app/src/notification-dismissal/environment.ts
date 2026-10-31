import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { HostDismissalView } from "./plan";
import type { NotificationDismissalEnvironment } from "./tracker";

function readHostView(serverId: string): HostDismissalView | null {
  const runtime = getHostRuntimeStore();
  if (!runtime.getHosts().some((host) => host.serverId === serverId)) return null;
  const snapshot = runtime.getSnapshot(serverId);
  const refresh = snapshot?.agentDirectoryRefresh ?? null;
  const current =
    snapshot?.connectionStatus === "online" &&
    refresh !== null &&
    refresh.clientGeneration === snapshot.clientGeneration &&
    refresh.connectionEpoch === snapshot.connectionEpoch;
  const session = useSessionStore.getState().sessions[serverId];
  return {
    current,
    refreshRequestedAt: current ? refresh.requestedAt : null,
    agent(agentId) {
      const agent = session?.agents.get(agentId);
      if (!agent) return null;
      return { requiresAttention: agent.requiresAttention === true, archived: !!agent.archivedAt };
    },
    hasPendingPermission(agentId) {
      // The session map follows permission_resolved events; the agent's own list only
      // changes on the next agent update.
      for (const pending of session?.pendingPermissions.values() ?? []) {
        if (pending.agentId === agentId) return true;
      }
      return false;
    },
  };
}

export function createAppNotificationDismissalEnvironment(): NotificationDismissalEnvironment {
  const runtime = getHostRuntimeStore();
  return {
    now: () => Date.now(),
    hostsLoaded: () => runtime.isHostRegistryLoaded(),
    host: readHostView,
    subscribe(onChange) {
      const unsubscribers = [
        useSessionStore.subscribe(onChange),
        runtime.subscribeAll(onChange),
        runtime.subscribeHostList(onChange),
      ];
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    acquireDirectory(serverId) {
      // The directory exists once the runtime has a controller for the host.
      if (!runtime.getSnapshot(serverId)) return null;
      return runtime.acquireDirectoryDemand(serverId);
    },
    refreshDirectory(serverId) {
      void runtime.refreshDirectories(serverId).catch(() => undefined);
    },
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}
