import { describe, expect, it } from "vitest";
import { agentNotificationKey } from "./key";
import type { AgentDismissalView } from "./plan";
import {
  createNotificationDismissalTracker,
  type NotificationDismissalEnvironment,
} from "./tracker";

const AGENT = { serverId: "host", agentId: "agent" };
const KEY = agentNotificationKey(AGENT);

class FakeEnvironment implements NotificationDismissalEnvironment {
  clock = 1_000;
  current = true;
  refreshRequestedAt: number | null = null;
  agentView: AgentDismissalView | null = { requiresAttention: false, archived: false };
  pendingPermission = false;
  configured = true;
  listener: (() => void) | null = null;
  demanded = new Set<string>();
  refreshed: string[] = [];
  timer: { callback: () => void; at: number } | null = null;

  now = () => this.clock;
  hostsLoaded = () => true;
  host = () =>
    this.configured
      ? {
          current: this.current,
          refreshRequestedAt: this.refreshRequestedAt,
          agent: () => this.agentView,
          hasPendingPermission: () => this.pendingPermission,
        }
      : null;
  subscribe = (onChange: () => void) => {
    this.listener = onChange;
    return () => {
      this.listener = null;
    };
  };
  acquireDirectory = (serverId: string) => {
    this.demanded.add(serverId);
    return () => this.demanded.delete(serverId);
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
  const dismissed: string[] = [];
  const tracker = createNotificationDismissalTracker({
    environment,
    dismiss: (keys) => dismissed.push(...keys),
  });
  return { environment, dismissed, tracker };
}

describe("notification dismissal tracker", () => {
  it("dismisses a read thread once the grace period passes, then lets go of the host", async () => {
    const { environment, dismissed, tracker } = setup();
    tracker.track(AGENT, "finished");
    expect(environment.demanded.has("host")).toBe(true);

    await environment.change(() => {
      environment.agentView = { requiresAttention: true, archived: false };
    });
    await environment.change(() => {
      environment.agentView = { requiresAttention: false, archived: false };
    });
    expect(dismissed).toEqual([]);

    environment.advanceTo(environment.clock + 1_500);
    expect(dismissed).toEqual([KEY]);
    expect(environment.demanded.size).toBe(0);
    expect(environment.listener).toBeNull();
  });

  it("restarts arming when a newer notification replaces the thread's entry", async () => {
    const { environment, dismissed, tracker } = setup();
    environment.pendingPermission = true;
    tracker.track(AGENT, "permission");
    await environment.change(() => {
      environment.pendingPermission = false;
    });
    // The question resolved; its grace timer is running when the turn-finished notice replaces it.
    environment.clock += 500;
    tracker.track(AGENT, "finished");
    environment.advanceTo(environment.clock + 5_000);
    expect(dismissed).toEqual([]);
  });

  it("asks for one refresh when the agent is missing and nothing arms the entry", async () => {
    const { environment, dismissed, tracker } = setup();
    environment.agentView = null;
    environment.refreshRequestedAt = 500;
    tracker.track(AGENT, "finished");
    environment.advanceTo(environment.clock + 1_500);
    expect(environment.refreshed).toEqual(["host"]);

    await environment.change(() => {
      environment.refreshRequestedAt = environment.clock;
    });
    environment.advanceTo(environment.clock + 1_500);
    expect(dismissed).toEqual([KEY]);
    expect(environment.refreshed).toEqual(["host"]);
  });

  it("forgets a notification that was never shown without dismissing it", () => {
    const { environment, dismissed, tracker } = setup();
    const key = tracker.track(AGENT, "finished");
    tracker.forget(key);
    expect(dismissed).toEqual([]);
    expect(environment.demanded.size).toBe(0);
  });

  it("dismisses at once when the host is removed", async () => {
    const { environment, dismissed, tracker } = setup();
    tracker.track(AGENT, "permission");
    await environment.change(() => {
      environment.configured = false;
    });
    expect(dismissed).toEqual([KEY]);
  });
});
