import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { HostCatchUpSummary } from "./caught-up";
import type { CaughtUpEnvironment } from "./caught-up-tracker";
import type { HostDismissalView } from "./plan";
import type { NotificationDismissalEnvironment } from "./tracker";

/** The latest whole-directory refresh, if it belongs to the host's live connection. */
function readCurrentRefresh(serverId: string): { requestedAt: number } | null {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  const refresh = snapshot?.agentDirectoryRefresh ?? null;
  const current =
    snapshot?.connectionStatus === "online" &&
    refresh !== null &&
    refresh.clientGeneration === snapshot.clientGeneration &&
    refresh.connectionEpoch === snapshot.connectionEpoch;
  return current ? refresh : null;
}

function readHostView(serverId: string): HostDismissalView | null {
  const runtime = getHostRuntimeStore();
  if (!runtime.getHosts().some((host) => host.serverId === serverId)) return null;
  const refresh = readCurrentRefresh(serverId);
  const session = useSessionStore.getState().sessions[serverId];
  return {
    current: refresh !== null,
    refreshRequestedAt: refresh?.requestedAt ?? null,
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

function readHostCatchUp(serverId: string): HostCatchUpSummary {
  const refresh = readCurrentRefresh(serverId);
  const session = useSessionStore.getState().sessions[serverId];
  let anyRequiresAttention = false;
  for (const agent of session?.agents.values() ?? []) {
    if (agent.requiresAttention === true && !agent.archivedAt) anyRequiresAttention = true;
  }
  return {
    current: refresh !== null,
    refreshRequestedAt: refresh?.requestedAt ?? null,
    anyRequiresAttention,
    anyPendingPermission: (session?.pendingPermissions.size ?? 0) > 0,
  };
}

function createSharedEnvironment() {
  const runtime = getHostRuntimeStore();
  return {
    now: () => Date.now(),
    subscribe(onChange: () => void) {
      const unsubscribers = [
        useSessionStore.subscribe(onChange),
        runtime.subscribeAll(onChange),
        runtime.subscribeHostList(onChange),
      ];
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    acquireDirectory(serverId: string) {
      // The directory exists once the runtime has a controller for the host.
      if (!runtime.getSnapshot(serverId)) return null;
      return runtime.acquireDirectoryDemand(serverId);
    },
    refreshDirectory(serverId: string) {
      void runtime.refreshDirectories(serverId).catch(() => undefined);
    },
    setTimer: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
    clearTimer: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

export function createAppNotificationDismissalEnvironment(): NotificationDismissalEnvironment {
  const runtime = getHostRuntimeStore();
  return {
    ...createSharedEnvironment(),
    hostsLoaded: () => runtime.isHostRegistryLoaded(),
    host: readHostView,
  };
}

export function createAppCaughtUpEnvironment(): CaughtUpEnvironment {
  const runtime = getHostRuntimeStore();
  return {
    ...createSharedEnvironment(),
    serverIds: () =>
      runtime.isHostRegistryLoaded() ? runtime.getHosts().map((host) => host.serverId) : null,
    host: readHostCatchUp,
  };
}
