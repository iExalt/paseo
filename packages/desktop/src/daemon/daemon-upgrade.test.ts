import { describe, expect, test } from "vitest";
import {
  createDaemonUpgrader,
  DAEMON_UPGRADE_RETRY_MS,
  needsDaemonUpgrade,
  type DaemonUpgradeStatus,
  type IdleStopResult,
  type DaemonUpgradeState,
} from "./daemon-upgrade.js";

const OLD: DaemonUpgradeStatus = {
  status: "running",
  serverId: "local",
  pid: 100,
  startedAt: "2026-11-04T00:00:00.000Z",
  version: "0.21.0",
  desktopManaged: true,
};
const OURS: DaemonUpgradeStatus = { ...OLD, pid: 200, startedAt: "later", version: "0.22.0" };
const STOPPED: DaemonUpgradeStatus = {
  status: "stopped",
  pid: null,
  startedAt: null,
  version: null,
  desktopManaged: false,
};

// A scripted daemon: each readStatus returns the next status (the last one repeats), each
// stopIfIdle the next result or error.
function harness(input: {
  statuses: DaemonUpgradeStatus[];
  stops?: Array<IdleStopResult | Error>;
  managementEnabled?: boolean;
  launchError?: Error;
  activeRelease?: Array<"active" | "inactive" | "unknown">;
}) {
  const releases = [...(input.activeRelease ?? ["active"])];
  const statuses = [...input.statuses];
  const stops = [...(input.stops ?? [])];
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const calls = { stop: 0, launch: 0 };
  const changes: Array<DaemonUpgradeState | null> = [];
  const upgrader = createDaemonUpgrader({
    appVersion: () => "0.22.0",
    platform: "darwin",
    readStatus: async () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!),
    stopIfIdle: async () => {
      calls.stop += 1;
      const next = stops.shift() ?? "declined";
      if (next instanceof Error) throw next;
      return next;
    },
    launch: async () => {
      calls.launch += 1;
      if (input.launchError) throw input.launchError;
      return OURS;
    },
    managementEnabled: async () => input.managementEnabled ?? true,
    isActiveRelease: async () => (releases.length > 1 ? releases.shift()! : releases[0]!),
    log: () => {},
    onStateChanged: () => changes.push(upgrader.getState(OLD)),
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const pending = () => timers.filter((timer) => !timer.cancelled);
  const fire = async () => {
    const [timer] = pending();
    timer!.cancelled = true;
    timer!.run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { upgrader, calls, pending, fire, statuses, changes };
}

describe("needsDaemonUpgrade", () => {
  test("replaces only a running desktop-managed daemon of another version, off Windows", () => {
    const check = (status: DaemonUpgradeStatus, platform: NodeJS.Platform = "darwin") =>
      needsDaemonUpgrade({ status, appVersion: "v0.22.0", platform });
    expect(check(OLD)).toBe(true);
    expect(check({ ...OLD, version: "0.23.0" })).toBe(true);
    expect(check({ ...OLD, version: "0.22.0" })).toBe(false);
    expect(check({ ...OLD, version: null })).toBe(false);
    expect(check({ ...OLD, desktopManaged: false })).toBe(false);
    expect(check({ ...OLD, status: "starting" })).toBe(false);
    expect(check(OLD, "linux")).toBe(true);
    expect(check(OLD, "win32")).toBe(false);
  });
});

describe("createDaemonUpgrader", () => {
  test("starts a daemon when none runs and keeps a matching one", async () => {
    const none = harness({ statuses: [STOPPED] });
    await expect(none.upgrader.ensure()).resolves.toBe(OURS);
    const current = harness({ statuses: [OURS] });
    await expect(current.upgrader.ensure()).resolves.toBe(OURS);
    expect(current.calls).toEqual({ stop: 0, launch: 0 });
  });

  test("replaces an idle daemon of another version at once", async () => {
    const { upgrader, calls, pending } = harness({ statuses: [OLD], stops: ["stopped"] });
    await expect(upgrader.ensure()).resolves.toBe(OURS);
    expect(calls).toEqual({ stop: 1, launch: 1 });
    expect(pending()).toEqual([]);
  });

  test("keeps a busy daemon and replaces it once a retry finds it idle", async () => {
    const { upgrader, calls, pending, fire, changes } = harness({
      statuses: [OLD],
      stops: ["declined", "stopped"],
    });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    expect(upgrader.getState(OLD)).toMatchObject({
      phase: "waiting",
      targetVersion: "0.22.0",
      serverId: "local",
    });
    expect(upgrader.getState({ ...OLD, pid: 999 })).toBeNull();
    expect(upgrader.getState({ ...OLD, serverId: "remote" })).toBeNull();
    expect(pending().map((timer) => timer.delayMs)).toEqual([DAEMON_UPGRADE_RETRY_MS]);

    await fire();
    expect(calls).toEqual({ stop: 2, launch: 1 });
    expect(changes.map((state) => state?.phase ?? null)).toEqual(["waiting", "upgrading", null]);
    expect(upgrader.getState(OURS)).toBeNull();
    expect(pending()).toEqual([]);
  });

  test("an app that is not the active release leaves a daemon of another version alone", async () => {
    const { upgrader, calls, pending } = harness({ statuses: [OLD], activeRelease: ["inactive"] });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    expect(calls).toEqual({ stop: 0, launch: 0 });
    expect(pending()).toEqual([]);
  });

  test("retries when the active-release check fails", async () => {
    const { upgrader, calls, fire } = harness({
      statuses: [OLD],
      stops: ["stopped"],
      activeRelease: ["unknown", "active"],
    });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    expect(calls.stop).toBe(0);
    expect(upgrader.getState(OLD)).toMatchObject({ phase: "checking", targetVersion: null });
    await fire();
    expect(calls).toEqual({ stop: 1, launch: 1 });
  });

  test("keeps a daemon without idle stop and does not retry", async () => {
    const { upgrader, calls, pending } = harness({ statuses: [OLD], stops: ["unsupported"] });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    expect(calls.launch).toBe(0);
    expect(upgrader.getState(OLD)?.phase).toBe("unsupported");
    expect(pending()).toEqual([]);
  });

  test("retains a failed launch after the old daemon stopped, until cancelled", async () => {
    const run = harness({
      statuses: [OLD],
      stops: ["stopped"],
      launchError: new Error("launch failed"),
    });
    await expect(run.upgrader.ensure()).rejects.toThrow("launch failed");
    expect(run.upgrader.getState(STOPPED)).toMatchObject({
      phase: "failed",
      serverId: "local",
      error: "Error: launch failed",
    });
    expect(run.upgrader.getState({ ...OLD, pid: 999 })).toBeNull();
    run.upgrader.cancel();
    expect(run.upgrader.getState(STOPPED)).toBeNull();
  });

  test("an unknown outcome starts ours when the daemon is gone", async () => {
    const { upgrader, calls } = harness({
      statuses: [OLD, STOPPED],
      stops: [new Error("timed out")],
    });
    await expect(upgrader.ensure()).resolves.toBe(OURS);
    expect(calls).toEqual({ stop: 1, launch: 1 });
  });

  test("an unknown outcome keeps a daemon still running and retries", async () => {
    const { upgrader, calls, pending } = harness({
      statuses: [OLD, OLD],
      stops: [new Error("STOP_NOT_CONFIRMED")],
    });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    expect(calls.launch).toBe(0);
    expect(pending()).toHaveLength(1);
  });

  test("decides again when another daemon replaced the one it asked", async () => {
    const replacement = { ...OLD, pid: 300, startedAt: "replaced" };
    const { upgrader, calls } = harness({
      statuses: [OLD, replacement],
      stops: [new Error("DAEMON_REPLACED"), "stopped"],
    });
    await expect(upgrader.ensure()).resolves.toBe(OURS);
    expect(calls).toEqual({ stop: 2, launch: 1 });
  });

  test("concurrent callers share one attempt", async () => {
    const { upgrader, calls } = harness({ statuses: [OLD], stops: ["stopped"] });
    const [first, second] = await Promise.all([upgrader.ensure(), upgrader.ensure()]);
    expect(first).toBe(OURS);
    expect(second).toBe(OURS);
    expect(calls).toEqual({ stop: 1, launch: 1 });
  });

  test("a retry never starts a daemon someone stopped while it waited", async () => {
    const cancelled = harness({ statuses: [OLD] });
    await cancelled.upgrader.ensure();
    cancelled.upgrader.cancel();
    expect(cancelled.pending()).toEqual([]);

    // Declined, then the user stops the daemon before the retry fires.
    const stopped = harness({ statuses: [OLD, STOPPED] });
    await stopped.upgrader.ensure();
    await stopped.fire();
    expect(stopped.calls).toEqual({ stop: 1, launch: 0 });
    expect(stopped.pending()).toEqual([]);
  });

  test("a stop during an attempt keeps the daemon stopped", async () => {
    const run = harness({ statuses: [OLD, STOPPED], stops: [new Error("timed out")] });
    // The user stops the daemon while the idle stop is in flight.
    const attempt = run.upgrader.ensure();
    run.upgrader.cancel();
    await expect(attempt).resolves.toBe(STOPPED);
    expect(run.calls.launch).toBe(0);
  });

  test("after an unknown outcome, a retry that finds the daemon gone starts ours", async () => {
    const { upgrader, calls, fire } = harness({
      statuses: [OLD, OLD, STOPPED],
      stops: [new Error("timed out")],
    });
    await expect(upgrader.ensure()).resolves.toBe(OLD);
    await fire();
    expect(calls).toEqual({ stop: 1, launch: 1 });
  });

  test("stops retrying once closed or once the app no longer manages the daemon", async () => {
    const closed = harness({ statuses: [OLD] });
    await closed.upgrader.ensure();
    closed.upgrader.close();
    expect(closed.pending()).toEqual([]);

    const unmanaged = harness({ statuses: [OLD], managementEnabled: false });
    await unmanaged.upgrader.ensure();
    await unmanaged.fire();
    expect(unmanaged.calls.stop).toBe(1);
    expect(unmanaged.pending()).toEqual([]);
  });
});
