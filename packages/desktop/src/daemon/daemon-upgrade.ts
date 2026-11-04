/**
 * Brings a desktop-managed daemon of another version up to the app's version without cutting off
 * running agents. The old daemon is asked to stop only when idle (the daemon checks and stops in
 * one step); while it is busy the app keeps using it and asks again every minute.
 */

export interface DaemonUpgradeStatus {
  status: "starting" | "running" | "stopped" | "errored";
  pid: number | null;
  startedAt: string | null;
  version: string | null;
  desktopManaged: boolean;
}

export type IdleStopResult = "stopped" | "declined" | "unsupported";

export interface DaemonUpgradeDeps<Status extends DaemonUpgradeStatus> {
  appVersion: () => string | null;
  platform: NodeJS.Platform;
  readStatus: () => Promise<Status>;
  /** Throws when the outcome is unknown (timeout, lost connection, replaced daemon). */
  stopIfIdle: () => Promise<IdleStopResult>;
  launch: () => Promise<Status>;
  /** Whether the app may still manage the daemon; a retry stops once it may not. */
  managementEnabled: () => Promise<boolean>;
  /** Whether this app is the release to converge on; a stale copy must not downgrade. */
  isActiveRelease: () => Promise<boolean>;
  /** Runs after an idle daemon was replaced. */
  onUpgraded?: () => void;
  log: (message: string, details?: Record<string, unknown>) => void;
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export const DAEMON_UPGRADE_RETRY_MS = 60_000;
// Each pass handles one daemon; a replaced daemon gets a fresh decision, a few at most.
const MAX_DECISIONS = 3;

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed.replace(/^v/i, "") : null;
}

function isLive(status: DaemonUpgradeStatus): boolean {
  return status.status === "running" || status.status === "starting";
}

function isSameInstance(a: DaemonUpgradeStatus, b: DaemonUpgradeStatus): boolean {
  return isLive(b) && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Whether the app should replace a running daemon. Never on Windows, where a surviving terminal
 * worker would lock the install folder; never for a daemon the user started outside the app.
 */
export function needsDaemonUpgrade(input: {
  status: DaemonUpgradeStatus;
  appVersion: string | null;
  platform: NodeJS.Platform;
}): boolean {
  if (input.platform === "win32" || input.status.status !== "running") return false;
  if (!input.status.desktopManaged) return false;
  const app = normalizeVersion(input.appVersion);
  const daemon = normalizeVersion(input.status.version);
  return Boolean(app && daemon && app !== daemon);
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createDaemonUpgrader<Status extends DaemonUpgradeStatus>(
  deps: DaemonUpgradeDeps<Status>,
) {
  const schedule = deps.schedule ?? defaultSchedule;
  let inFlight: Promise<Status> | null = null;
  let cancelRetry: (() => void) | null = null;
  let closed = false;
  // Bumped by cancel(): an attempt or retry already under way must not undo a deliberate stop.
  let generation = 0;

  /**
   * A retry belongs to the daemon it waited on. If that daemon is gone when it fires, someone
   * stopped it on purpose and the retry drops, unless the last stop attempt's outcome was
   * unknown: then the gone daemon may be that stop, finished late, and ours starts.
   */
  function scheduleRetry(target: Status, launchIfGone: boolean): void {
    if (closed || cancelRetry) return;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      void retry(target, launchIfGone);
    }, DAEMON_UPGRADE_RETRY_MS);
  }

  async function retry(target: Status, launchIfGone: boolean): Promise<void> {
    const started = generation;
    try {
      if (closed || !(await deps.managementEnabled())) return;
      const current = await deps.readStatus();
      if (closed || cancelRetry || inFlight || generation !== started) return;
      if (isSameInstance(target, current) || (launchIfGone && !isLive(current))) await ensure();
    } catch (error) {
      deps.log("daemon upgrade retry failed", { error: String(error) });
      scheduleRetry(target, launchIfGone);
    }
  }

  async function decide(): Promise<Status> {
    const started = generation;
    const launch = async () => {
      if (generation !== started) return deps.readStatus();
      return deps.launch();
    };
    let current = await deps.readStatus();
    for (let decision = 0; decision < MAX_DECISIONS; decision += 1) {
      if (!isLive(current)) return launch();
      const appVersion = deps.appVersion();
      if (!needsDaemonUpgrade({ status: current, appVersion, platform: deps.platform }))
        return current;
      const details = { pid: current.pid, daemonVersion: current.version, appVersion };
      if (!(await deps.isActiveRelease())) {
        deps.log("app is not the active release; leaving the daemon alone", details);
        return current;
      }
      let result: IdleStopResult;
      try {
        result = await deps.stopIfIdle();
      } catch (error) {
        // The daemon may have stopped after all; act on what is running now.
        const after = await deps.readStatus();
        deps.log("idle stop outcome unknown", { ...details, error: String(error) });
        if (isSameInstance(current, after)) {
          scheduleRetry(current, true);
          return current;
        }
        current = after;
        continue;
      }
      if (result === "unsupported") {
        deps.log("daemon cannot stop only when idle; keeping it until it is stopped", details);
        return current;
      }
      if (result === "declined") {
        deps.log("daemon busy; upgrade waits for its agents", details);
        scheduleRetry(current, false);
        return current;
      }
      deps.log("idle daemon stopped for upgrade", details);
      const launched = await launch();
      deps.onUpgraded?.();
      return launched;
    }
    return current;
  }

  /** Returns the daemon to use now; concurrent callers share one attempt. */
  function ensure(): Promise<Status> {
    if (closed) return deps.readStatus();
    if (inFlight) return inFlight;
    cancelRetry?.();
    cancelRetry = null;
    inFlight = decide().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** Drops a pending retry; a deliberate stop must not be undone by a timer. */
  function cancel(): void {
    generation += 1;
    cancelRetry?.();
    cancelRetry = null;
  }

  function close(): void {
    closed = true;
    cancel();
  }

  return { ensure, cancel, close };
}
