import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCatchUpSummary, UntrackedPush } from "./caught-up";
import { createCaughtUpTracker, type CaughtUpEnvironment } from "./caught-up-tracker";

const PUSH: UntrackedPush = { identifier: "push", kind: "finished", deliveredAt: 500 };

function setup() {
  const hosts = new Map<string, HostCatchUpSummary>([
    [
      "a",
      {
        current: true,
        refreshRequestedAt: 1000,
        anyRequiresAttention: true,
        anyPendingPermission: false,
      },
    ],
    [
      "b",
      {
        current: true,
        refreshRequestedAt: 1000,
        anyRequiresAttention: false,
        anyPendingPermission: false,
      },
    ],
  ]);
  const listeners = new Set<() => void>();
  const demand = new Set<string>();
  const refreshed: string[] = [];
  const dismissed: string[][] = [];
  const environment: CaughtUpEnvironment = {
    now: () => Date.now(),
    serverIds: () => [...hosts.keys()],
    host: (serverId) => hosts.get(serverId)!,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    acquireDirectory(serverId) {
      demand.add(serverId);
      return () => demand.delete(serverId);
    },
    refreshDirectory: (serverId) => refreshed.push(serverId),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  const tracker = createCaughtUpTracker({
    environment,
    dismiss: (identifiers) => dismissed.push(identifiers),
  });
  const update = async (serverId: string, patch: Partial<HostCatchUpSummary>) => {
    hosts.set(serverId, { ...hosts.get(serverId)!, ...patch });
    for (const listener of listeners) listener();
    await Promise.resolve();
  };
  return { tracker, demand, refreshed, dismissed, listeners, update };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("caught-up tracker", () => {
  it("watches every host while untracked pushes wait and dismisses once all are read", async () => {
    vi.useFakeTimers({ now: 2000 });
    const { tracker, demand, refreshed, dismissed, listeners, update } = setup();
    tracker.refreshAll();
    expect(refreshed).toEqual([]);

    tracker.setPushes([PUSH]);
    tracker.refreshAll();
    expect([...demand]).toEqual(["a", "b"]);
    expect(refreshed).toEqual(["a", "b"]);

    await update("a", { anyRequiresAttention: false });
    vi.advanceTimersByTime(1499);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([["push"]]);

    tracker.setPushes([]);
    expect(demand.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("restarts the grace when a read state is seen again after the shade emptied", async () => {
    vi.useFakeTimers({ now: 2000 });
    const { tracker, dismissed, update } = setup();
    await update("a", { anyRequiresAttention: false });
    tracker.setPushes([PUSH]);
    tracker.setPushes([]);
    vi.advanceTimersByTime(5000);
    tracker.setPushes([PUSH]);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(dismissed).toEqual([["push"]]);
  });

  it("does nothing after dispose", () => {
    const { tracker, demand, refreshed } = setup();
    tracker.setPushes([PUSH]);
    tracker.dispose();
    expect(demand.size).toBe(0);
    tracker.setPushes([PUSH]);
    tracker.refreshAll();
    expect(demand.size).toBe(0);
    expect(refreshed).toEqual([]);
  });
});
