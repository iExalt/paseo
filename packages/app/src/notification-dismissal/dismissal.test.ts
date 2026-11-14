import { describe, expect, it } from "vitest";
import type { HostCatchUpSummary, UntrackedPush } from "./caught-up";
import { createNotificationDismissal, type NotificationDismissalEnvironment } from "./dismissal";
import { agentNotificationKey } from "./key";
import type { AgentDismissalView } from "./plan";

const AGENT = { serverId: "a", agentId: "agent" };
const KEY = agentNotificationKey(AGENT);
const GRACE = 1_500;
const PUSH: UntrackedPush = {
  identifier: "push",
  kind: "finished",
  title: "Fix the build",
  deliveredAt: 500,
};
const UNREAD = [{ pushTitle: "Fix the build", raisedAt: 400 }];

/** The app's stores, host runtime and timers in memory, driven by the test's clock. */
class FakeEnvironment implements NotificationDismissalEnvironment {
  clock = 1_000;
  /** Configured hosts; a tracked thread's agent lives on host "a". */
  hosts = new Map<string, HostCatchUpSummary>([
    ["a", { current: true, refreshRequestedAt: 900, finished: [], question: [] }],
    ["b", { current: true, refreshRequestedAt: 900, finished: [], question: [] }],
  ]);
  agentView: AgentDismissalView | null = { requiresAttention: false, archived: false };
  pendingPermission = false;
  listener: (() => void) | null = null;
  demanded = new Map<string, number>();
  refreshed: string[] = [];
  timer: { callback: () => void; at: number } | null = null;

  now = () => this.clock;
  serverIds = () => [...this.hosts.keys()];
  host = (serverId: string) => {
    const host = this.hosts.get(serverId);
    if (!host) return null;
    return {
      current: host.current,
      refreshRequestedAt: host.refreshRequestedAt,
      agent: () => this.agentView,
      hasPendingPermission: () => this.pendingPermission,
    };
  };
  catchUp = (serverId: string) => this.hosts.get(serverId)!;
  subscribe = (onChange: () => void) => {
    this.listener = onChange;
    return () => {
      this.listener = null;
    };
  };
  acquireDirectory = (serverId: string) => {
    this.demanded.set(serverId, (this.demanded.get(serverId) ?? 0) + 1);
    return () => {
      const count = (this.demanded.get(serverId) ?? 0) - 1;
      if (count > 0) this.demanded.set(serverId, count);
      else this.demanded.delete(serverId);
    };
  };
  refreshDirectory = (serverId: string) => {
    this.refreshed.push(serverId);
  };
  setTimer = (callback: () => void, delayMs: number) => {
    this.timer = { callback, at: this.clock + delayMs };
    return this.timer;
  };
  clearTimer = (timer: unknown) => {
    if (this.timer === timer) this.timer = null;
  };

  /** Applies a state change the way a store update would, then lets the microtask run. */
  async change(update: () => void): Promise<void> {
    update();
    this.listener?.();
    await Promise.resolve();
  }

  updateHost(serverId: string, patch: Partial<HostCatchUpSummary>): Promise<void> {
    return this.change(() => this.hosts.set(serverId, { ...this.hosts.get(serverId)!, ...patch }));
  }

  advanceTo(at: number): void {
    this.clock = at;
    const timer = this.timer;
    if (timer && timer.at <= at) {
      this.timer = null;
      timer.callback();
    }
  }
}

function setup() {
  const environment = new FakeEnvironment();
  const threads: string[] = [];
  const pushes: string[][] = [];
  const dismissal = createNotificationDismissal({
    environment,
    dismissThreads: (keys) => threads.push(...keys),
    dismissPushes: (identifiers) => pushes.push(identifiers),
  });
  return { environment, threads, pushes, dismissal };
}

describe("notification dismissal: tracked threads", () => {
  it("dismisses a read thread once the grace period passes, then lets go of the host", async () => {
    const { environment, threads, dismissal } = setup();
    dismissal.track(AGENT, "finished");
    expect([...environment.demanded.keys()]).toEqual(["a"]);

    await environment.change(() => {
      environment.agentView = { requiresAttention: true, archived: false };
    });
    await environment.change(() => {
      environment.agentView = { requiresAttention: false, archived: false };
    });
    expect(threads).toEqual([]);

    environment.advanceTo(environment.clock + GRACE);
    expect(threads).toEqual([KEY]);
    expect(environment.demanded.size).toBe(0);
    expect(environment.listener).toBeNull();
  });

  it("restarts arming when a newer notification replaces the thread's entry", async () => {
    const { environment, threads, dismissal } = setup();
    environment.pendingPermission = true;
    dismissal.track(AGENT, "permission");
    await environment.change(() => {
      environment.pendingPermission = false;
    });
    // The question resolved; its grace timer is running when the turn-finished notice replaces it.
    environment.clock += 500;
    dismissal.track(AGENT, "finished");
    environment.advanceTo(environment.clock + 5_000);
    expect(threads).toEqual([]);
  });

  it("asks for one refresh when the agent is missing and nothing arms the entry", async () => {
    const { environment, threads, dismissal } = setup();
    environment.agentView = null;
    environment.hosts.set("a", { ...environment.hosts.get("a")!, refreshRequestedAt: 500 });
    dismissal.track(AGENT, "finished");
    environment.advanceTo(environment.clock + GRACE);
    expect(environment.refreshed).toEqual(["a"]);

    await environment.updateHost("a", { refreshRequestedAt: environment.clock });
    environment.advanceTo(environment.clock + GRACE);
    expect(threads).toEqual([KEY]);
    expect(environment.refreshed).toEqual(["a"]);
  });

  it("keeps a fresh entry when a leftover from an earlier launch names the same thread", () => {
    const { environment, threads, dismissal } = setup();
    // Stale store state: the leftover sweep must not re-arm this launch's notification.
    environment.hosts.set("a", { ...environment.hosts.get("a")!, refreshRequestedAt: 500 });
    dismissal.track(AGENT, "finished");
    dismissal.track(AGENT, "unknown", { createdAt: 0, ifAbsent: true });
    environment.advanceTo(environment.clock + 5_000);
    expect(threads).toEqual([]);

    const leftover = setup();
    leftover.environment.hosts.set("a", {
      ...leftover.environment.hosts.get("a")!,
      refreshRequestedAt: 500,
    });
    leftover.dismissal.track(AGENT, "unknown", { createdAt: 0, ifAbsent: true });
    leftover.environment.advanceTo(leftover.environment.clock + GRACE);
    expect(leftover.threads).toEqual([KEY]);
  });

  it("forgets a notification that was never shown without dismissing it", () => {
    const { environment, threads, dismissal } = setup();
    const key = dismissal.track(AGENT, "finished");
    dismissal.forget(key);
    expect(threads).toEqual([]);
    expect(environment.demanded.size).toBe(0);
  });

  it("dismisses during track() when the host is already gone, and at once when it goes", async () => {
    const { environment, threads, dismissal } = setup();
    environment.hosts.delete("a");
    dismissal.track(AGENT, "permission");
    // Synchronous: the desktop and browser send paths record the dismissal before showing.
    expect(threads).toEqual([KEY]);

    const removed = setup();
    removed.dismissal.track(AGENT, "permission");
    await removed.environment.change(() => removed.environment.hosts.delete("a"));
    expect(removed.threads).toEqual([KEY]);
  });
});

describe("notification dismissal: untracked pushes", () => {
  it("watches every host while pushes wait and dismisses them once all are read", async () => {
    const { environment, pushes, dismissal } = setup();
    await environment.updateHost("a", { finished: UNREAD });
    dismissal.refreshAll();
    expect(environment.refreshed).toEqual([]);

    dismissal.setUntrackedPushes([PUSH]);
    dismissal.refreshAll();
    expect([...environment.demanded.keys()]).toEqual(["a", "b"]);
    expect(environment.refreshed).toEqual(["a", "b"]);

    await environment.updateHost("a", { finished: [] });
    environment.advanceTo(environment.clock + GRACE - 1);
    expect(pushes).toEqual([]);
    environment.advanceTo(environment.clock + 1);
    expect(pushes).toEqual([["push"]]);

    dismissal.setUntrackedPushes([]);
    expect(environment.demanded.size).toBe(0);
    expect(environment.listener).toBeNull();
  });

  it("restarts the grace when the shade empties, even while a tracked thread keeps watching", () => {
    const { environment, pushes, dismissal } = setup();
    environment.agentView = { requiresAttention: true, archived: false };
    dismissal.track(AGENT, "finished");
    dismissal.setUntrackedPushes([PUSH]);
    dismissal.setUntrackedPushes([]);
    expect(environment.listener).not.toBeNull();
    environment.clock += 5_000;
    dismissal.setUntrackedPushes([PUSH]);
    expect(pushes).toEqual([]);
    environment.advanceTo(environment.clock + GRACE);
    expect(pushes).toEqual([["push"]]);
  });

  it("does not let tracked activity shorten a push's grace", async () => {
    const { environment, pushes, dismissal } = setup();
    dismissal.setUntrackedPushes([PUSH]);
    const caughtUpAt = environment.clock;
    environment.clock += 10;
    environment.agentView = { requiresAttention: true, archived: false };
    dismissal.track(AGENT, "finished");
    await environment.change(() => {
      environment.clock = caughtUpAt + GRACE - 1;
    });
    expect(pushes).toEqual([]);
    environment.advanceTo(caughtUpAt + GRACE);
    expect(pushes).toEqual([["push"]]);
  });

  it("keeps a host's directory while the other kind still needs it", () => {
    const { environment, threads, dismissal } = setup();
    environment.hosts.set("a", { ...environment.hosts.get("a")!, finished: UNREAD });
    dismissal.setUntrackedPushes([PUSH]);
    dismissal.track(AGENT, "permission");
    expect(environment.demanded).toEqual(
      new Map([
        ["a", 1],
        ["b", 1],
      ]),
    );
    dismissal.forget(KEY);
    expect(threads).toEqual([]);
    expect([...environment.demanded.keys()]).toEqual(["a", "b"]);
  });

  it("stays inert after dispose, even for a sync that was already in flight", () => {
    const { environment, dismissal } = setup();
    dismissal.setUntrackedPushes([PUSH]);
    dismissal.dispose();
    expect(environment.demanded.size).toBe(0);
    dismissal.track(AGENT, "finished");
    dismissal.setUntrackedPushes([PUSH]);
    dismissal.refreshAll();
    expect(environment.listener).toBeNull();
    expect(environment.demanded.size).toBe(0);
    expect(environment.refreshed).toEqual([]);
  });
});
