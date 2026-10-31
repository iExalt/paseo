import {
  planCaughtUpDismissals,
  type CaughtUpSince,
  type HostCatchUpSummary,
  type UntrackedPush,
} from "./caught-up";

export interface CaughtUpEnvironment {
  now(): number;
  /** Every configured host; null until the saved host list has loaded. */
  serverIds(): string[] | null;
  host(serverId: string): HostCatchUpSummary;
  subscribe(onChange: () => void): () => void;
  acquireDirectory(serverId: string): (() => void) | null;
  refreshDirectory(serverId: string): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface CaughtUpTracker {
  /** Replaces the untracked pushes in the shade. */
  setPushes(pushes: UntrackedPush[]): void;
  /** Refreshes every host while untracked pushes wait, so a foreground settles them. */
  refreshAll(): void;
  dispose(): void;
}

/**
 * Holds every host's directory live while untracked pushes are in the shade, and dismisses
 * them once nothing they could be about is still waiting.
 */
export function createCaughtUpTracker(input: {
  environment: CaughtUpEnvironment;
  dismiss: (identifiers: string[]) => void;
}): CaughtUpTracker {
  const { environment } = input;
  let pushes: UntrackedPush[] = [];
  let caughtUpSince: CaughtUpSince = { question: null, finished: null };
  const directoryReleases = new Map<string, () => void>();
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;
  let scheduled = false;
  let disposed = false;

  function syncDirectoryDemand(): void {
    const servers = new Set(pushes.length > 0 ? (environment.serverIds() ?? []) : []);
    for (const [serverId, release] of directoryReleases) {
      if (servers.has(serverId)) continue;
      release();
      directoryReleases.delete(serverId);
    }
    for (const serverId of servers) {
      if (directoryReleases.has(serverId)) continue;
      const release = environment.acquireDirectory(serverId);
      if (release) directoryReleases.set(serverId, release);
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
    if (disposed) return;
    if (pushes.length > 0 && !unsubscribe) unsubscribe = environment.subscribe(schedule);
    if (pushes.length === 0) {
      unsubscribe?.();
      unsubscribe = null;
      // Unobserved from here on, so a later push must see the state stay caught up anew.
      caughtUpSince = { question: null, finished: null };
    }
    syncDirectoryDemand();
    if (pushes.length === 0) {
      setRecheck(null);
      return;
    }
    const serverIds = environment.serverIds();
    const plan = planCaughtUpDismissals({
      pushes,
      hosts: serverIds?.map((serverId) => environment.host(serverId)) ?? null,
      caughtUpSince,
      now: environment.now(),
    });
    caughtUpSince = plan.caughtUpSince;
    setRecheck(plan.recheckAt);
    if (plan.dismiss.length === 0) return;
    const dismissed = new Set(plan.dismiss);
    pushes = pushes.filter((push) => !dismissed.has(push.identifier));
    input.dismiss(plan.dismiss);
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (scheduled) reconcile();
    });
  }

  return {
    setPushes(next) {
      if (disposed) return;
      pushes = next;
      reconcile();
    },
    refreshAll() {
      if (disposed || pushes.length === 0) return;
      for (const serverId of environment.serverIds() ?? []) {
        environment.refreshDirectory(serverId);
      }
    },
    dispose() {
      disposed = true;
      setRecheck(null);
      unsubscribe?.();
      unsubscribe = null;
      for (const release of directoryReleases.values()) release();
      directoryReleases.clear();
      pushes = [];
      scheduled = false;
    },
  };
}
