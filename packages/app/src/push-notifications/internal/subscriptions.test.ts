import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(async () => null),
}));
const storage = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-notifications", () => ({
  ...notifications,
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "project" } } }));
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));

import { reregisterPushToken, usePushRegistrationStore } from "../registration";
import { startSubscription } from "./subscriptions";

function fakeClient(connected: boolean) {
  const listeners = new Set<(state: { status: string }) => void>();
  const client = {
    isConnected: connected,
    registerPushToken: vi.fn(),
    subscribeConnectionStatus: (listener: (state: { status: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setConnected(next: boolean) {
      client.isConnected = next;
      for (const listener of listeners) listener({ status: next ? "connected" : "disconnected" });
    },
  };
  return client;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("push subscription registration status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    appStateListeners.clear();
    usePushRegistrationStore.setState({}, true);
    notifications.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    notifications.getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[a]" });
  });

  it("reports a build without Firebase once per session instead of warning on every connect", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    notifications.getExpoPushTokenAsync.mockRejectedValue(
      new Error(
        "Unable to get Firebase Messaging instance. Did you configure `googleServicesFile`?",
      ),
    );

    const stops = [
      startSubscription({ client: fakeClient(true) as never, serverId: "a" }),
      startSubscription({ client: fakeClient(true) as never, serverId: "b" }),
    ];
    await settle();

    expect(usePushRegistrationStore.getState()).toMatchObject({ a: "failed", b: "failed" });
    expect(info.mock.calls).toEqual([
      ["[paseo-agent] push register status=unavailable reason=firebase-not-configured"],
    ]);
    expect(warn).not.toHaveBeenCalled();
    for (const stop of stops) stop();

    notifications.getExpoPushTokenAsync.mockRejectedValue(
      new Error("Firebase Installations Service is unavailable"),
    );
    const stop = startSubscription({ client: fakeClient(true) as never, serverId: "c" });
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
    info.mockRestore();
    warn.mockRestore();
  });

  it("follows the connection once the token resolves", async () => {
    const client = fakeClient(false);
    const stop = startSubscription({ client: client as never, serverId: "host" });
    await settle();
    expect(usePushRegistrationStore.getState().host).toBe("not-connected");

    client.setConnected(true);
    expect(usePushRegistrationStore.getState().host).toBe("sent");
    expect(client.registerPushToken).toHaveBeenCalledWith("ExponentPushToken[a]");

    stop();
    expect(usePushRegistrationStore.getState().host).toBeUndefined();
  });

  it("retries a missing permission when the app returns from system settings", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: false });
    startSubscription({ client: fakeClient(true) as never, serverId: "host" });
    await settle();
    notifications.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });

    for (const listener of appStateListeners) listener("active");
    await settle();

    expect(usePushRegistrationStore.getState().host).toBe("sent");
  });

  it("never prompts for notification access when the app returns to the foreground", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: true });
    notifications.requestPermissionsAsync.mockResolvedValue({
      status: "denied",
      canAskAgain: true,
    });
    startSubscription({ client: fakeClient(true) as never, serverId: "host" });
    await settle();
    notifications.requestPermissionsAsync.mockClear();

    for (const listener of appStateListeners) listener("active");
    await settle();

    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(usePushRegistrationStore.getState().host).toBe("no-permission");
  });

  it("reports a missing permission, then re-registers on request", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: false });
    const client = fakeClient(true);
    startSubscription({ client: client as never, serverId: "host" });
    await settle();
    expect(usePushRegistrationStore.getState().host).toBe("no-permission");

    notifications.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    reregisterPushToken("host");
    await settle();
    expect(usePushRegistrationStore.getState().host).toBe("sent");
  });
});
