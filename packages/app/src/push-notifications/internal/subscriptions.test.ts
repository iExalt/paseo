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
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
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
    usePushRegistrationStore.setState({}, true);
    notifications.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    notifications.getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[a]" });
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
