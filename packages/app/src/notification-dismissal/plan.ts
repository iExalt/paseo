import type { TrackedNotificationReason } from "./key";

/** How long a resolved condition must stay resolved before its notification goes. */
export const DISMISS_GRACE_MS = 1_500;

export interface TrackedNotification {
  key: string;
  serverId: string;
  agentId: string;
  reason: TrackedNotificationReason;
  /** Client clock time the notification was shown or delivered. */
  createdAt: number;
  /**
   * Whether this client has evidence newer than the notification. Until then a resolved
   * condition may be state that predates the notification: the daemon sends the
   * attention event before the agent update that explains it.
   */
  armed: boolean;
  /** When the condition was first seen resolved after arming; reset if it comes back. */
  resolvedSince: number | null;
  /** Whether a directory refresh was already requested to arm an entry for a missing agent. */
  absenceRefreshRequested: boolean;
}

export interface AgentDismissalView {
  requiresAttention: boolean;
  archived: boolean;
}

export interface HostDismissalView {
  /**
   * Online, with an agent-directory refresh completed on the current connection.
   * Cached or offline state never dismisses anything.
   */
  current: boolean;
  /** Client clock time that refresh was requested. */
  refreshRequestedAt: number | null;
  agent(agentId: string): AgentDismissalView | null;
  hasPendingPermission(agentId: string): boolean;
}

export interface DismissalPlanInput {
  entries: readonly TrackedNotification[];
  /** False until the saved host list has loaded; an unloaded list looks like removed hosts. */
  hostsLoaded: boolean;
  /** Null when the host is no longer configured in the app. */
  host(serverId: string): HostDismissalView | null;
  now: number;
  graceMs?: number;
}

export interface DismissalPlan {
  /** Entries that stay tracked, with updated arming state. */
  entries: TrackedNotification[];
  dismiss: string[];
  /**
   * Hosts to refresh. An agent archived before this client saw it is missing from a
   * directory that is already current, and nothing else would arm its notification.
   */
  refresh: string[];
  /** When a pending grace period ends and the plan should run again. */
  recheckAt: number | null;
}

function isConditionActive(
  entry: TrackedNotification,
  agent: AgentDismissalView | null,
  host: HostDismissalView,
): boolean {
  // An agent missing from a current directory counts as resolved, not removed: a new
  // agent's first update can arrive after its first notification.
  if (!agent) return false;
  const pendingPermission = host.hasPendingPermission(entry.agentId);
  switch (entry.reason) {
    case "permission":
      return pendingPermission;
    case "finished":
    case "error":
      return agent.requiresAttention;
    case "unknown":
      return agent.requiresAttention || pendingPermission;
  }
}

export function planNotificationDismissals(input: DismissalPlanInput): DismissalPlan {
  const graceMs = input.graceMs ?? DISMISS_GRACE_MS;
  if (!input.hostsLoaded) {
    return { entries: [...input.entries], dismiss: [], refresh: [], recheckAt: null };
  }
  const entries: TrackedNotification[] = [];
  const dismiss: string[] = [];
  const refresh = new Set<string>();
  let recheckAt: number | null = null;
  const recheck = (at: number) => {
    recheckAt = recheckAt === null ? at : Math.min(recheckAt, at);
  };

  for (const entry of input.entries) {
    const host = input.host(entry.serverId);
    if (!host) {
      dismiss.push(entry.key);
      continue;
    }
    if (!host.current) {
      entries.push(entry);
      continue;
    }
    const agent = host.agent(entry.agentId);
    if (agent?.archived) {
      dismiss.push(entry.key);
      continue;
    }
    if (isConditionActive(entry, agent, host)) {
      entries.push({ ...entry, armed: true, resolvedSince: null });
      continue;
    }
    const armed =
      entry.armed ||
      (host.refreshRequestedAt !== null && host.refreshRequestedAt > entry.createdAt);
    if (!armed) {
      if (agent || entry.absenceRefreshRequested) {
        entries.push(entry);
      } else if (input.now >= entry.createdAt + graceMs) {
        refresh.add(entry.serverId);
        entries.push({ ...entry, absenceRefreshRequested: true });
      } else {
        entries.push(entry);
        recheck(entry.createdAt + graceMs);
      }
      continue;
    }
    const resolvedSince = entry.resolvedSince ?? input.now;
    const dueAt = resolvedSince + graceMs;
    if (input.now >= dueAt) {
      dismiss.push(entry.key);
      continue;
    }
    entries.push({ ...entry, armed: true, resolvedSince });
    recheck(dueAt);
  }

  return { entries, dismiss, refresh: [...refresh], recheckAt };
}
