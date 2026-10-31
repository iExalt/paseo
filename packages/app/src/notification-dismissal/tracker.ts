import {
  agentNotificationKey,
  type AgentNotificationIdentity,
  type TrackedNotificationReason,
} from "./key";
import {
  planNotificationDismissals,
  type HostDismissalView,
  type TrackedNotification,
} from "./plan";

export interface NotificationDismissalEnvironment {
  now(): number;
  hostsLoaded(): boolean;
  host(serverId: string): HostDismissalView | null;
  /** Calls `onChange` whenever agent, permission, connection or host-list state changes. */
  subscribe(onChange: () => void): () => void;
  /** Keeps the host's agent directory loaded and live; returns the release. */
  acquireDirectory(serverId: string): (() => void) | null;
  refreshDirectory(serverId: string): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface NotificationDismissalTracker {
  /**
   * Starts tracking a notification about to be shown. Call it before awaiting delivery so
   * state changes during the await are seen. A newer notification for the same thread
   * replaces the older entry and its arming state.
   */
  track(
    identity: AgentNotificationIdentity,
    reason: TrackedNotificationReason,
    options?: {
      /** Defaults to now. Zero for leftovers from an earlier launch: any fresh state is newer. */
      createdAt?: number;
      /** Keep an existing entry for the thread; a notification from this launch is newer. */
      ifAbsent?: boolean;
    },
  ): string;
  /** Stops tracking without dismissing, for a notification that was never shown. */
  forget(key: string): void;
  /** Re-evaluates now, for state the environment cannot observe (app foreground). */
  reconcile(): void;
  dispose(): void;
}

export function createNotificationDismissalTracker(input: {
  environment: NotificationDismissalEnvironment;
  dismiss: (keys: string[]) => void;
}): NotificationDismissalTracker {
  const { environment } = input;
  let entries = new Map<string, TrackedNotification>();
  const directoryReleases = new Map<string, () => void>();
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;
  let scheduled = false;

  function syncDirectoryDemand(): void {
    const servers = new Set([...entries.values()].map((entry) => entry.serverId));
    for (const [serverId, release] of directoryReleases) {
      if (servers.has(serverId)) continue;
      release();
      directoryReleases.delete(serverId);
    }
    for (const serverId of servers) {
      if (directoryReleases.has(serverId)) continue;
      // Null until the host runtime knows the host; retried on the next change.
      const release = environment.acquireDirectory(serverId);
      if (release) directoryReleases.set(serverId, release);
    }
  }

  function syncSubscription(): void {
    if (entries.size > 0 && !unsubscribe) unsubscribe = environment.subscribe(schedule);
    if (entries.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function setRecheck(at: number | null): void {
    if (timer !== null) environment.clearTimer(timer);
    timer = null;
    if (at === null) return;
    timer = environment.setTimer(
      () => {
        timer = null;
        reconcile();
      },
      Math.max(0, at - environment.now()),
    );
  }

  function reconcile(): void {
    scheduled = false;
    const plan = planNotificationDismissals({
      entries: [...entries.values()],
      hostsLoaded: environment.hostsLoaded(),
      host: (serverId) => environment.host(serverId),
      now: environment.now(),
    });
    entries = new Map(plan.entries.map((entry) => [entry.key, entry]));
    syncDirectoryDemand();
    syncSubscription();
    setRecheck(plan.recheckAt);
    for (const serverId of plan.refresh) environment.refreshDirectory(serverId);
    if (plan.dismiss.length > 0) input.dismiss(plan.dismiss);
  }

  // Store updates arrive in bursts while agents stream; plan once per burst.
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (scheduled) reconcile();
    });
  }

  return {
    track(identity, reason, options) {
      const key = agentNotificationKey(identity);
      if (options?.ifAbsent && entries.has(key)) return key;
      entries.set(key, {
        key,
        serverId: identity.serverId,
        agentId: identity.agentId,
        reason,
        createdAt: options?.createdAt ?? environment.now(),
        armed: false,
        resolvedSince: null,
        absenceRefreshRequested: false,
      });
      reconcile();
      return key;
    },
    forget(key) {
      if (!entries.delete(key)) return;
      reconcile();
    },
    reconcile,
    dispose() {
      setRecheck(null);
      unsubscribe?.();
      unsubscribe = null;
      for (const release of directoryReleases.values()) release();
      directoryReleases.clear();
      entries.clear();
      scheduled = false;
    },
  };
}
