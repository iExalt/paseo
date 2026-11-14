import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: string[] = [];

  class FakeNotification {
    static instances: FakeNotification[] = [];
    static remove = vi.fn((ids: string[]) => events.push(`remove:${ids.join(",")}`));
    static getHistory = vi.fn(async () => [] as Array<{ id: string; groupId: string }>);
    static isSupported = () => true;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(readonly options: { title: string; id?: string; groupId?: string }) {
      FakeNotification.instances.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void) {
      return this.on(event, listener);
    }
    emit(event: string) {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    show() {
      events.push(`show:${this.options.title}`);
      this.emit("show");
    }
    close = vi.fn(() => {
      events.push(`close:${this.options.title}`);
    });
  }

  return {
    handlers,
    events,
    FakeNotification,
    module: {
      app: { name: "Paseo" },
      BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
      Notification: FakeNotification,
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(channel, handler),
      },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    },
  };
});

vi.mock("electron", () => electron.module);
vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({ get: async () => ({ notifications: { playSound: false } }) }),
}));

import { registerNotificationHandlers } from "./notifications";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler({ sender: {} }, ...args));
}

async function send(title: string): Promise<void> {
  const id = "paseo-agent:host:agent";
  await invoke("paseo:notification:send", { title, id, groupId: `${id}:finished` });
}

describe("desktop notification handlers", () => {
  beforeEach(() => {
    registerNotificationHandlers();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    electron.events.length = 0;
    electron.FakeNotification.instances.length = 0;
    electron.FakeNotification.remove.mockClear();
  });

  it("replaces a thread's notification on macOS without closing the old object", async () => {
    setPlatform("darwin");
    await send("First");
    await send("Second");
    const [first, second] = electron.FakeNotification.instances;
    expect(first?.close).not.toHaveBeenCalled();
    expect(second?.options.groupId).toBe("paseo-agent:host:agent:finished");

    // The replaced object's late close event must not untrack the new notification.
    first?.emit("close");
    await invoke("paseo:notification:dismiss", ["paseo-agent:host:agent", "unknown"]);
    // The live one is closed, freeing its native object; only the leftover goes by id.
    expect(second?.close).toHaveBeenCalledTimes(1);
    expect(first?.close).not.toHaveBeenCalled();
    expect(electron.FakeNotification.remove).toHaveBeenCalledWith(["unknown"]);
  });

  it.each(["linux", "win32"] as const)(
    "closes the old notification before showing its replacement on %s",
    async (platform) => {
      setPlatform(platform);
      await send("First");
      await send("Second");
      expect(electron.events).toEqual(["show:First", "close:First", "show:Second"]);
      const [, second] = electron.FakeNotification.instances;
      // Windows replaces a toast only when tag and group both match.
      expect(second?.options.groupId).toBe(
        platform === "win32" ? "paseo-agent:host:agent" : undefined,
      );

      await invoke("paseo:notification:dismiss", ["paseo-agent:host:agent", "unknown"]);
      expect(second?.close).toHaveBeenCalledTimes(1);
      expect(electron.FakeNotification.remove).not.toHaveBeenCalled();
    },
  );

  it("lists macOS history from earlier launches", async () => {
    electron.FakeNotification.getHistory.mockResolvedValueOnce([
      { id: "paseo-agent:host:agent", groupId: "paseo-agent:host:agent:permission" },
      { id: "", groupId: "" },
    ]);
    setPlatform("darwin");
    expect(await invoke("paseo:notification:delivered")).toEqual([
      { id: "paseo-agent:host:agent", groupId: "paseo-agent:host:agent:permission" },
    ]);
  });

  it("lists this process's live notifications with their reason for a reloaded window", async () => {
    setPlatform("linux");
    await send("Live");
    expect(await invoke("paseo:notification:delivered")).toEqual([
      { id: "paseo-agent:host:agent", groupId: "paseo-agent:host:agent:finished" },
    ]);
    await invoke("paseo:notification:dismiss", ["paseo-agent:host:agent"]);
    expect(await invoke("paseo:notification:delivered")).toEqual([]);
  });
});
