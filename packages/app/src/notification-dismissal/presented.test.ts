import { describe, expect, it, vi } from "vitest";
import { agentNotificationKey } from "./key";
import {
  createPresentedNotificationSync,
  presentedAtMs,
  type PresentedNotification,
} from "./presented";
import type { NotificationDismissalTracker } from "./tracker";

const KEY = agentNotificationKey({ serverId: "host", agentId: "agent" });

function push(identifier: string, deliveredAt: number, reason = "finished"): PresentedNotification {
  return {
    identifier,
    deliveredAt,
    data: { serverId: "host", workspaceId: "w", agentId: "agent", reason },
  };
}

function setup(shade: PresentedNotification[]) {
  const tracked: Array<{ reason: string; createdAt?: number }> = [];
  const forgotten: string[] = [];
  const dismissed: string[] = [];
  const tracker: NotificationDismissalTracker = {
    track: (identity, reason, options) => {
      tracked.push({ reason, createdAt: options?.createdAt });
      return agentNotificationKey(identity);
    },
    forget: (key) => forgotten.push(key),
    reconcile: () => undefined,
    dispose: () => undefined,
  };
  const sync = createPresentedNotificationSync({
    api: {
      list: async () => [...shade],
      dismiss: async (identifier) => {
        dismissed.push(identifier);
      },
    },
    tracker: () => tracker,
    isTrackable: (data) => (data as { kind?: string }).kind !== "test",
  });
  return { shade, sync, tracked, forgotten, dismissed };
}

describe("presented notification sync", () => {
  it("tracks each thread once, by its newest push, and skips test and foreign notifications", async () => {
    const { shade, sync, tracked } = setup([
      push("a", 100, "permission"),
      push("b", 300, "finished"),
      { identifier: "test", deliveredAt: 400, data: { kind: "test", serverId: "host" } },
      { identifier: "foreign", deliveredAt: 500, data: { android: "extras" } },
    ]);
    await sync.sync();
    await sync.sync();
    expect(tracked).toEqual([{ reason: "finished", createdAt: 300 }]);

    shade.push(push("c", 600, "permission"));
    await sync.sync();
    expect(tracked.at(-1)).toEqual({ reason: "permission", createdAt: 600 });
  });

  it("dismisses the thread's pushes up to the tracked one, leaving a newer arrival", async () => {
    const { shade, sync, dismissed } = setup([push("a", 100), push("b", 200)]);
    await sync.sync();
    shade.push(push("late", 900));
    await sync.dismiss([KEY]);
    expect(dismissed).toEqual(["a", "b"]);
  });

  it("forgets a thread the user cleared from the shade", async () => {
    const { shade, sync, forgotten } = setup([push("a", 100)]);
    await sync.sync();
    shade.length = 0;
    await sync.sync();
    expect(forgotten).toEqual([KEY]);
  });

  it("runs one sync at a time, so a late older listing cannot forget a newer push", async () => {
    const tracked: string[] = [];
    const forgotten: string[] = [];
    const listings: Array<(shade: PresentedNotification[]) => void> = [];
    const sync = createPresentedNotificationSync({
      api: {
        list: () => new Promise((resolve) => listings.push(resolve)),
        dismiss: async () => undefined,
      },
      tracker: () => ({
        track: (identity) => {
          tracked.push(identity.agentId);
          return agentNotificationKey(identity);
        },
        forget: (key) => forgotten.push(key),
        reconcile: () => undefined,
        dispose: () => undefined,
      }),
    });
    const first = sync.sync();
    const second = sync.sync();
    expect(listings).toHaveLength(1);
    listings[0]?.([]);
    await vi.waitFor(() => expect(listings).toHaveLength(2));
    // The queued pass lists again and sees the push that arrived meanwhile.
    listings[1]?.([push("x", 500)]);
    await Promise.all([first, second]);
    expect(tracked).toEqual(["agent"]);
    expect(forgotten).toEqual([]);
  });

  it("hands pushes without thread data to the caught-up tracker, classified by title", async () => {
    const untracked: unknown[] = [];
    const sync = createPresentedNotificationSync({
      api: {
        list: async () => [
          push("a", 100),
          { identifier: "q", deliveredAt: 200, data: {}, title: "❓️ Plan", body: "Approve?" },
          { identifier: "f", deliveredAt: 300, data: {}, title: "Plan", body: "Done" },
        ],
        dismiss: async () => undefined,
      },
      tracker: () => ({
        track: (identity) => agentNotificationKey(identity),
        forget: () => undefined,
        reconcile: () => undefined,
        dispose: () => undefined,
      }),
      onUntracked: (pushes) => untracked.push(pushes),
    });
    await sync.sync();
    expect(untracked).toEqual([
      [
        { identifier: "q", kind: "question", deliveredAt: 200 },
        { identifier: "f", kind: "finished", deliveredAt: 300 },
      ],
    ]);
  });

  it("waits for both conditions when a question and a turn end arrive in the same millisecond", async () => {
    const { sync, tracked } = setup([push("a", 100, "finished"), push("b", 100, "permission")]);
    await sync.sync();
    expect(tracked).toEqual([{ reason: "unknown", createdAt: 100 }]);
  });

  it("converts iOS delivery seconds to milliseconds", () => {
    expect(presentedAtMs("ios", 1_793_425_755.5)).toBe(1_793_425_755_500);
    expect(presentedAtMs("android", 1_793_425_755_500)).toBe(1_793_425_755_500);
  });
});
