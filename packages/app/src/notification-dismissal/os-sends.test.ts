import { describe, expect, it, vi } from "vitest";
import { agentNotificationKey } from "./key";
import { createOsNotificationSends, type TrackedWebNotification } from "./os-sends";

const KEY = "paseo-agent:srv-1:agent-1";
const data = (reason: string) => ({
  serverId: "srv-1",
  workspaceId: "w",
  agentId: "agent-1",
  reason,
});

function setup() {
  const tracked: Array<{ agentId: string; reason: string; options?: unknown }> = [];
  const forgotten: string[] = [];
  const desktopDismissed: string[][] = [];
  let dismissThreads: (keys: string[]) => void = () => undefined;
  const sends = createOsNotificationSends({
    createDismissal(dismiss) {
      dismissThreads = dismiss;
      return {
        track: (identity, reason, options) => {
          tracked.push({ agentId: identity.agentId, reason, ...(options ? { options } : {}) });
          return agentNotificationKey(identity);
        },
        forget: (key) => void forgotten.push(key),
      };
    },
    dismissDesktop: (keys) => void desktopDismissed.push(keys),
  });
  return {
    sends,
    tracked,
    forgotten,
    desktopDismissed,
    dismiss: (keys: string[]) => dismissThreads(keys),
  };
}

function webNotification() {
  const closeListeners: Array<() => void> = [];
  const notification: TrackedWebNotification = {
    addEventListener: (_type, listener) => void closeListeners.push(listener),
    close: () => undefined,
  };
  return { notification, closeByUser: () => closeListeners.forEach((listener) => listener()) };
}

describe("desktop and browser notification sends", () => {
  it("drops a browser notification resolved during the permission prompt, and forgets one the user closes", () => {
    const { sends, forgotten, dismiss } = setup();
    const first = sends.beginWeb(data("finished"))!;
    expect(first.options).toEqual({ tag: KEY, renotify: true });
    dismiss([KEY]);
    expect(first.afterPermission(true)).toEqual({ show: false, result: true });

    // Two sends for the thread wait on the same prompt; the newer owns the slot and a
    // dismissal resolves it.
    const older = sends.beginWeb(data("finished"))!;
    const newer = sends.beginWeb(data("finished"))!;
    dismiss([KEY]);
    expect(older.afterPermission(true)).toEqual({ show: false, result: false });
    expect(newer.afterPermission(true)).toEqual({ show: false, result: true });

    const denied = sends.beginWeb(data("finished"))!;
    expect(denied.afterPermission(false)).toEqual({ show: false, result: false });
    expect(forgotten).toEqual([KEY]);

    const unread = sends.beginWeb(data("finished"))!;
    expect(unread.afterPermission(true)).toEqual({ show: true });
    const { notification, closeByUser } = webNotification();
    unread.shown(notification);
    closeByUser();
    expect(forgotten).toEqual([KEY, KEY]);
    expect(sends.beginWeb({ title: "no agent" })).toBeNull();
  });

  it("sends desktop notifications keyed by thread and removes them when dismissed", async () => {
    const { sends, forgotten, desktopDismissed, dismiss } = setup();
    const shows: Array<(shown: boolean) => void> = [];
    const send = vi.fn(() => new Promise<boolean>((resolve) => shows.push(resolve)));

    // Resolved while the main process is still showing it: removed once it is up.
    const pending = sends.sendDesktop(send, { title: "Question", data: data("permission") });
    expect(send).toHaveBeenCalledWith({
      title: "Question",
      data: data("permission"),
      id: KEY,
      groupId: `${KEY}:permission`,
    });
    dismiss([KEY]);
    expect(desktopDismissed).toEqual([[KEY]]);
    shows[0]?.(true);
    await pending;
    expect(desktopDismissed).toEqual([[KEY], [KEY]]);

    // Not shown: stop tracking it.
    const refused = sends.sendDesktop(send, { title: "Question", data: data("permission") });
    shows[1]?.(false);
    await refused;
    expect(forgotten).toEqual([KEY]);
  });

  it("adopts this thread's leftovers from an earlier launch without replacing fresh entries", () => {
    const { sends, tracked } = setup();
    sends.adoptDelivered([
      { id: KEY, groupId: `${KEY}:finished` },
      { id: "unrelated-uuid", groupId: "" },
    ]);
    expect(tracked).toEqual([
      { agentId: "agent-1", reason: "finished", options: { createdAt: 0, ifAbsent: true } },
    ]);
  });
});
