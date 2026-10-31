import { WEB_NOTIFICATION_CLICK_EVENT } from "@/notification-open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockNotificationOptions {
  body?: string;
  data?: Record<string, unknown>;
  icon?: string;
  tag?: string;
  renotify?: boolean;
}

interface FakeDismissal {
  tracked: Array<{ serverId: string; agentId: string; reason: string; options?: unknown }>;
  forgotten: string[];
  dismiss: (keys: string[]) => void;
}

interface MockNotificationInstance {
  title: string;
  options?: MockNotificationOptions;
  clickListeners: Array<(event: Event) => void>;
  addEventListener: (event: string, listener: (event: Event) => void) => void;
  close: ReturnType<typeof vi.fn>;
}

interface GlobalSnapshot {
  Notification: unknown;
  CustomEvent: unknown;
  dispatchEvent: unknown;
  focus: unknown;
  location: unknown;
}

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  CustomEvent: (globalThis as { CustomEvent?: unknown }).CustomEvent,
  dispatchEvent: (globalThis as { dispatchEvent?: unknown }).dispatchEvent,
  focus: (globalThis as { focus?: unknown }).focus,
  location: (globalThis as { location?: unknown }).location,
};

async function loadModuleForPlatform(
  platform: "web" | "ios" | "android",
  options?: {
    desktopHost?: {
      notification?: {
        sendNotification?: (payload: {
          title: string;
          body?: string;
          data?: Record<string, unknown>;
          id?: string;
          groupId?: string;
        }) => Promise<boolean>;
        dismissNotifications?: (ids: string[]) => Promise<void>;
        getDeliveredNotifications?: () => Promise<Array<{ id: string; groupId: string }>>;
      };
    } | null;
  },
) {
  vi.resetModules();
  const dismissal: FakeDismissal = { tracked: [], forgotten: [], dismiss: () => undefined };
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("@/notification-dismissal", async () => {
    const key = await import("@/notification-dismissal/key");
    return {
      readAgentNotificationData: key.readAgentNotificationData,
      agentNotificationKey: key.agentNotificationKey,
      agentNotificationGroupId: key.agentNotificationGroupId,
      parseDeliveredAgentNotification: key.parseDeliveredAgentNotification,
      createAppNotificationDismissalTracker: (dismiss: (keys: string[]) => void) => {
        dismissal.dismiss = dismiss;
        return {
          track: (
            identity: { serverId: string; agentId: string },
            reason: string,
            trackOptions?: unknown,
          ) => {
            dismissal.tracked.push({
              ...identity,
              reason,
              ...(trackOptions ? { options: trackOptions } : {}),
            });
            return key.agentNotificationKey(identity);
          },
          forget: (trackedKey: string) => dismissal.forgotten.push(trackedKey),
          reconcile: () => undefined,
          dispose: () => undefined,
        };
      },
    };
  });
  vi.doMock("@/desktop/host", () => ({
    getDesktopHost: () => options?.desktopHost ?? null,
  }));
  vi.doMock("expo-asset", () => ({
    Asset: {
      fromModule: vi.fn(() => ({
        uri: "http://localhost:8081/packages/app/assets/images/notification-icon.png",
      })),
    },
  }));
  return { ...(await import("./os-notifications")), dismissal };
}

function restoreGlobals(): void {
  (globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification;
  (globalThis as { CustomEvent?: unknown }).CustomEvent = originalGlobals.CustomEvent;
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = originalGlobals.dispatchEvent;
  (globalThis as { focus?: unknown }).focus = originalGlobals.focus;
  (globalThis as { location?: unknown }).location = originalGlobals.location;
}

describe("sendOsNotification", () => {
  beforeEach(() => {
    class MockCustomEvent<T = unknown> {
      type: string;
      detail: T;
      cancelable: boolean;
      defaultPrevented = false;

      constructor(type: string, init?: { detail?: T; cancelable?: boolean }) {
        this.type = type;
        this.detail = (init?.detail ?? null) as T;
        this.cancelable = init?.cancelable ?? false;
      }

      preventDefault(): void {
        if (this.cancelable) {
          this.defaultPrevented = true;
        }
      }
    }

    (globalThis as { CustomEvent?: unknown }).CustomEvent = MockCustomEvent;
    (globalThis as { focus?: unknown }).focus = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("react-native");
    vi.doUnmock("@/notification-dismissal");
    vi.restoreAllMocks();
    vi.resetModules();
    restoreGlobals();
  });

  it("dispatches a click event that the app can handle", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return false;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as {
      type?: string;
      detail?: { data?: Record<string, unknown> };
    };
    expect(event?.type).toBe(WEB_NOTIFICATION_CLICK_EVENT);
    expect(event?.detail).toEqual({
      data: { serverId: "srv-1", agentId: "agent-1" },
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves navigation to the app when no listener handles the click", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return true;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    await sendOsNotification({
      title: "Agent finished",
      data: {
        serverId: "srv with space",
        workspaceId: "workspace-1",
        agentId: "agent/1",
      },
    });

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(assign).not.toHaveBeenCalled();
  });

  it("returns false when the Notification API is unavailable", async () => {
    (globalThis as { Notification?: unknown }).Notification = undefined;
    const { sendOsNotification } = await loadModuleForPlatform("web");
    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(false);
  });

  it("does not attach a click handler when there is no route target", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = vi.fn();
    (globalThis as { location?: unknown }).location = { assign: vi.fn() };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.clickListeners).toHaveLength(0);
  });

  it("gives each thread one tagged notification and closes it when dismissed", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(): void {}
    }

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    const { sendOsNotification, dismissal } = await loadModuleForPlatform("web");
    const data = { serverId: "srv-1", workspaceId: "w", agentId: "agent-1", reason: "finished" };

    await sendOsNotification({ title: "First", data });
    await sendOsNotification({ title: "Second", data });
    await sendOsNotification({ title: "Test", body: "No agent" });

    const key = "paseo-agent:srv-1:agent-1";
    expect(created.map((notification) => notification.options?.tag)).toEqual([key, key, undefined]);
    expect(created[1]?.options?.renotify).toBe(true);
    expect(created[2]?.options).not.toHaveProperty("renotify");
    expect(dismissal.tracked).toEqual([
      { serverId: "srv-1", agentId: "agent-1", reason: "finished" },
      { serverId: "srv-1", agentId: "agent-1", reason: "finished" },
    ]);

    dismissal.dismiss([key]);
    // The browser already replaced the first notification; only the live one is closed.
    expect(created[0]?.close).not.toHaveBeenCalled();
    expect(created[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("drops a notification resolved while permission was pending, and forgets one the user closes", async () => {
    const created: Array<{ title: string; closeListeners: Array<() => void> }> = [];
    let grant!: (permission: string) => void;

    class MockNotification {
      static permission = "default";
      static requestPermission = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            grant = resolve;
          }),
      );
      closeListeners: Array<() => void> = [];
      close = vi.fn();
      constructor(public title: string) {
        created.push(this);
      }
      addEventListener(event: string, listener: () => void): void {
        if (event === "close") this.closeListeners.push(listener);
      }
    }

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    const { sendOsNotification, dismissal } = await loadModuleForPlatform("web");
    const data = { serverId: "srv-1", workspaceId: "w", agentId: "agent-1", reason: "finished" };
    const key = "paseo-agent:srv-1:agent-1";

    const first = sendOsNotification({ title: "Read elsewhere", data });
    await Promise.resolve();
    dismissal.dismiss([key]);
    grant("granted");
    MockNotification.permission = "granted";
    await first;
    expect(created).toHaveLength(0);

    // Two sends for the thread wait on the same prompt; a dismissal resolves both.
    MockNotification.permission = "default";
    const older = sendOsNotification({ title: "Older", data });
    const newer = sendOsNotification({ title: "Newer", data });
    await Promise.resolve();
    dismissal.dismiss([key]);
    grant("granted");
    MockNotification.permission = "granted";
    await Promise.all([older, newer]);
    expect(created).toHaveLength(0);

    await sendOsNotification({ title: "Unread", data });
    expect(created).toHaveLength(1);
    created[0]?.closeListeners.forEach((listener) => listener());
    expect(dismissal.forgotten).toEqual([key]);
  });

  it("uses the desktop notification bridge when available", async () => {
    const sendNotification = vi.fn(async () => true);

    const { sendOsNotification } = await loadModuleForPlatform("web", {
      desktopHost: {
        notification: {
          sendNotification,
        },
      },
    });

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });

    expect(sent).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });
  });

  it("sends desktop notifications keyed by thread and removes them when dismissed", async () => {
    const shows: Array<(shown: boolean) => void> = [];
    const sendNotification = vi.fn(() => new Promise<boolean>((resolve) => shows.push(resolve)));
    const dismissNotifications = vi.fn(async () => undefined);
    const { sendOsNotification, dismissal } = await loadModuleForPlatform("web", {
      desktopHost: { notification: { sendNotification, dismissNotifications } },
    });
    const data = { serverId: "srv-1", workspaceId: "w", agentId: "agent-1", reason: "permission" };
    const key = "paseo-agent:srv-1:agent-1";

    // Resolved while the main process is still showing it: removed once it is up.
    const pending = sendOsNotification({ title: "Question", data });
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Question",
      data,
      id: key,
      groupId: `${key}:permission`,
    });
    dismissal.dismiss([key]);
    expect(dismissNotifications).toHaveBeenLastCalledWith([key]);
    dismissNotifications.mockClear();
    shows[0]?.(true);
    await pending;
    expect(dismissNotifications).toHaveBeenCalledWith([key]);

    // Not shown: stop tracking it.
    const refused = sendOsNotification({ title: "Question", data });
    shows[1]?.(false);
    await refused;
    expect(dismissal.forgotten).toEqual([key]);
  });

  it("adopts this thread's leftovers from an earlier launch without replacing fresh entries", async () => {
    const key = "paseo-agent:srv-1:agent-1";
    const { adoptDeliveredOsNotifications, dismissal } = await loadModuleForPlatform("web", {
      desktopHost: {
        notification: {
          sendNotification: async () => true,
          getDeliveredNotifications: async () => [
            { id: key, groupId: `${key}:finished` },
            { id: "unrelated-uuid", groupId: "" },
          ],
        },
      },
    });

    await adoptDeliveredOsNotifications();

    expect(dismissal.tracked).toEqual([
      {
        serverId: "srv-1",
        agentId: "agent-1",
        reason: "finished",
        options: { createdAt: 0, ifAbsent: true },
      },
    ]);
  });
});
