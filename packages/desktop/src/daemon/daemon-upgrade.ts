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

  function scheduleRetry(): void {
    if (closed || cancelRetry) return;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      void retry();
    }, DAEMON_UPGRADE_RETRY_MS);
  }

  async function retry(): Promise<void> {
    try {
      if (closed || !(await deps.managementEnabled())) return;
      await ensure();
    } catch (error) {
      deps.log("daemon upgrade retry failed", { error: String(error) });
      scheduleRetry();
    }
  }

  async function decide(): Promise<Status> {
    let current = await deps.readStatus();
    for (let decision = 0; decision < MAX_DECISIONS; decision += 1) {
      if (!isLive(current)) return deps.launch();
      const appVersion = deps.appVersion();
      if (!needsDaemonUpgrade({ status: current, appVersion, platform: deps.platform }))
        return current;
      const details = { pid: current.pid, daemonVersion: current.version, appVersion };
      let result: IdleStopResult;
      try {
        result = await deps.stopIfIdle();
      } catch (error) {
        // The daemon may have stopped after all; act on what is running now.
        const after = await deps.readStatus();
        deps.log("idle stop outcome unknown", { ...details, error: String(error) });
        if (isSameInstance(current, after)) {
          scheduleRetry();
          return current;
        }
        current = after;
        continue;
      }
      if (result === "unsupported") {
        deps.log("daemon cannot stop only when idle; keeping it until it is restarted", details);
        return current;
      }
      if (result === "declined") {
        deps.log("daemon busy; upgrade waits for its agents", details);
        scheduleRetry();
        return current;
      }
      deps.log("idle daemon stopped for upgrade", details);
      return deps.launch();
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

  function close(): void {
    closed = true;
    cancelRetry?.();
    cancelRetry = null;
  }

  return { ensure, close };
}
