import {
  planCaughtUpDismissals,
  type CaughtUpSince,
  type HostCatchUpSummary,
  type UntrackedPush,
} from "./caught-up";
import {
  createDismissalDriver,
  type DismissalDriverEnvironment,
  type DismissalPlan,
} from "./driver";
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

export interface NotificationDismissalEnvironment extends DismissalDriverEnvironment {
  /** Every configured host; null until the saved host list has loaded. */
  serverIds(): string[] | null;
  /** What a tracked notification's thread looks like on its host; null for a removed host. */
  host(serverId: string): HostDismissalView | null;
  /** What could still be waiting on a host, for pushes that name no thread. */
  catchUp(serverId: string): HostCatchUpSummary;
}

export interface NotificationDismissal {
  /**
   * Starts tracking a notification about to be shown. Call it before awaiting delivery so
   * state changes during the await are seen; it can dismiss before it returns. A newer
   * notification for the same thread replaces the older entry and its arming state.
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
  /** Replaces the pushes in the shade that name no thread (Android posts those itself). */
  setUntrackedPushes(pushes: UntrackedPush[]): void;
  /** Refreshes every host while untracked pushes wait, so a foreground settles them. */
  refreshAll(): void;
  /** Re-evaluates now, for state the environment cannot observe (app foreground). */
  reconcile(): void;
  dispose(): void;
}

/** Tracked threads: dismissed once read, answered, archived or gone. */
function createThreadPlan(
  environment: NotificationDismissalEnvironment,
  dismiss: (keys: string[]) => void,
) {
  let entries = new Map<string, TrackedNotification>();
  const plan: DismissalPlan = {
    active: () => entries.size > 0,
    servers: () => new Set([...entries.values()].map((entry) => entry.serverId)),
    evaluate(now) {
      const next = planNotificationDismissals({
        entries: [...entries.values()],
        hostsLoaded: environment.serverIds() !== null,
        host: (serverId) => environment.host(serverId),
        now,
      });
      entries = new Map(next.entries.map((entry) => [entry.key, entry]));
      return {
        refresh: next.refresh,
        recheckAt: next.recheckAt,
        dismiss: next.dismiss.length > 0 ? () => dismiss(next.dismiss) : null,
      };
    },
    dispose: () => entries.clear(),
  };
  return { plan, entries: () => entries };
}

/** Untracked pushes: dismissed once every host is caught up on whatever could have raised them. */
function createPushPlan(
  environment: NotificationDismissalEnvironment,
  dismiss: (identifiers: string[]) => void,
) {
  let pushes: UntrackedPush[] = [];
  let caughtUpSince: CaughtUpSince = new Map();
  const plan: DismissalPlan = {
    active: () => pushes.length > 0,
    servers: () => (pushes.length > 0 ? (environment.serverIds() ?? []) : []),
    evaluate(now) {
      if (pushes.length === 0) {
        // Unobserved from here on, so a later push must see the state stay caught up anew.
        caughtUpSince = new Map();
        return { refresh: [], recheckAt: null, dismiss: null };
      }
      const serverIds = environment.serverIds();
      const next = planCaughtUpDismissals({
        pushes,
        hosts: serverIds?.map((serverId) => environment.catchUp(serverId)) ?? null,
        caughtUpSince,
        now,
      });
      caughtUpSince = next.caughtUpSince;
      if (next.dismiss.length === 0)
        return { refresh: [], recheckAt: next.recheckAt, dismiss: null };
      return {
        refresh: [],
        recheckAt: next.recheckAt,
        dismiss: () => {
          const dismissed = new Set(next.dismiss);
          pushes = pushes.filter((push) => !dismissed.has(push.identifier));
          dismiss(next.dismiss);
        },
      };
    },
    dispose: () => {
      pushes = [];
    },
  };
  return {
    plan,
    pushes: () => pushes,
    setPushes: (next: UntrackedPush[]) => {
      pushes = next;
    },
  };
}

/**
 * Removes notifications once nothing is left to see in them. Tracked notifications name
 * their thread; untracked pushes (Android posts them while Paseo is closed) only go once
 * every host is caught up.
 */
export function createNotificationDismissal(input: {
  environment: NotificationDismissalEnvironment;
  /** Removes tracked notifications by thread key. */
  dismissThreads: (keys: string[]) => void;
  /** Removes untracked pushes by notification identifier. */
  dismissPushes?: (identifiers: string[]) => void;
}): NotificationDismissal {
  const { environment } = input;
  const threads = createThreadPlan(environment, input.dismissThreads);
  const pushes = createPushPlan(environment, input.dismissPushes ?? (() => undefined));
  const driver = createDismissalDriver({ environment, plans: [threads.plan, pushes.plan] });

  return {
    track(identity, reason, options) {
      const key = agentNotificationKey(identity);
      if (driver.disposed) return key;
      const entries = threads.entries();
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
      driver.reconcile();
      return key;
    },
    forget(key) {
      if (!threads.entries().delete(key)) return;
      driver.reconcile();
    },
    setUntrackedPushes(next) {
      if (driver.disposed) return;
      pushes.setPushes(next);
      driver.reconcile();
    },
    refreshAll() {
      if (driver.disposed || pushes.pushes().length === 0) return;
      for (const serverId of environment.serverIds() ?? []) {
        environment.refreshDirectory(serverId);
      }
    },
    reconcile: driver.reconcile,
    dispose: driver.dispose,
  };
}
