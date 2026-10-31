import { describe, expect, it } from "vitest";
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

  it("converts iOS delivery seconds to milliseconds", () => {
    expect(presentedAtMs("ios", 1_793_425_755.5)).toBe(1_793_425_755_500);
    expect(presentedAtMs("android", 1_793_425_755_500)).toBe(1_793_425_755_500);
  });
});
