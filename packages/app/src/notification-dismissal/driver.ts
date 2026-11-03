/** What the driver needs from the app: a clock, store changes, directory demand and timers. */
export interface DismissalDriverEnvironment {
  now(): number;
  /** Calls `onChange` whenever agent, permission, connection or host-list state changes. */
  subscribe(onChange: () => void): () => void;
  /** Keeps the host's agent directory loaded and live; returns the release. */
  acquireDirectory(serverId: string): (() => void) | null;
  refreshDirectory(serverId: string): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface DismissalPlanStep {
  /** Hosts to refresh now. */
  refresh: readonly string[];
  /** When to evaluate again with no state change; null for no deadline. */
  recheckAt: number | null;
  /** Applies the plan's dismissals; runs after demand, subscription and timer are settled. */
  dismiss: (() => void) | null;
}

/**
 * One kind of dismissal the driver runs. Each keeps its own memory (arming, caught-up times)
 * so one plan's state can't leak into another's.
 */
export interface DismissalPlan {
  /** Whether it waits on anything; the driver watches the stores only while some plan does. */
  active(): boolean;
  /** Hosts whose directory must stay loaded and live. */
  servers(): Iterable<string>;
  evaluate(now: number): DismissalPlanStep;
  dispose(): void;
}

export interface DismissalDriver {
  /** Evaluates every plan now. */
  reconcile(): void;
  readonly disposed: boolean;
  dispose(): void;
}

/**
 * Runs dismissal plans against the app: one store subscription, one directory demand per
 * host, one recheck timer, and one evaluation per burst of store updates.
 */
export function createDismissalDriver(input: {
  environment: DismissalDriverEnvironment;
  plans: readonly DismissalPlan[];
}): DismissalDriver {
  const { environment, plans } = input;
  const directoryReleases = new Map<string, () => void>();
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;
  let scheduled = false;
  // An async caller can still reach a disposed driver; it must not resubscribe or demand.
  let disposed = false;

  function syncDirectoryDemand(): void {
    const servers = new Set(plans.flatMap((plan) => [...plan.servers()]));
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
    const active = plans.some((plan) => plan.active());
    if (active && !unsubscribe) unsubscribe = environment.subscribe(schedule);
    if (!active && unsubscribe) {
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
    if (disposed) return;
    const now = environment.now();
    const steps = plans.map((plan) => plan.evaluate(now));
    syncDirectoryDemand();
    syncSubscription();
    const rechecks = steps.flatMap((step) => (step.recheckAt === null ? [] : [step.recheckAt]));
    setRecheck(rechecks.length > 0 ? Math.min(...rechecks) : null);
    for (const step of steps) {
      for (const serverId of step.refresh) environment.refreshDirectory(serverId);
    }
    for (const step of steps) step.dismiss?.();
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
    reconcile,
    get disposed() {
      return disposed;
    },
    dispose() {
      disposed = true;
      setRecheck(null);
      unsubscribe?.();
      unsubscribe = null;
      for (const release of directoryReleases.values()) release();
      directoryReleases.clear();
      for (const plan of plans) plan.dispose();
      scheduled = false;
    },
  };
}
