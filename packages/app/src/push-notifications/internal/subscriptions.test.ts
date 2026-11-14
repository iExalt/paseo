import { QueryClient } from "@tanstack/react-query";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { ServerInfoStatusPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "@/hooks/use-settings/fakes";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  saveAppSettings,
  type AppSettings,
  type SettingsDeps,
} from "@/hooks/use-settings/storage";
import { startSubscription } from "./subscriptions";
import type { PushNotificationClient } from "./types";

function createFakePushClient(options?: {
  isConnected?: boolean;
  pushNotificationPreferences?: boolean;
}) {
  let connected = options?.isConnected ?? true;
  let serverInfo: ServerInfoStatusPayload = {
    status: "server_info",
    serverId: "srv-test",
    hostname: "test-host",
    version: "0.18.0",
    ...(options?.pushNotificationPreferences !== undefined
      ? {
          features: {
            pushNotificationPreferences: options.pushNotificationPreferences,
          },
        }
      : {}),
  };

  const connectionListeners = new Set<(state: ConnectionState) => void>();
  const statusListeners = new Set<(message: SessionOutboundMessage) => void>();
  const registrations: Array<{
    token: string;
    preferencesProvided: boolean;
    preferences: NotificationPreferences | undefined;
  }> = [];

  const client: PushNotificationClient = {
    get isConnected() {
      return connected;
    },
    registerPushToken(token: string, preferences?: NotificationPreferences) {
      registrations.push({
        token,
        preferencesProvided: arguments.length >= 2 && preferences !== undefined,
        preferences,
      });
    },
    async unregisterPushToken() {},
    getLastServerInfoMessage() {
      return serverInfo;
    },
    subscribeConnectionStatus(listener: (state: ConnectionState) => void) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    on(type: "status", handler: (message: SessionOutboundMessage) => void) {
      if (type === "status") {
        statusListeners.add(handler);
      }
      return () => {
        statusListeners.delete(handler);
      };
    },
  };

  return {
    client,
    registrations,
    setConnected(nextConnected: boolean) {
      connected = nextConnected;
      const state: ConnectionState = nextConnected
        ? { status: "connected" }
        : { status: "disconnected" };
      for (const listener of connectionListeners) {
        listener(state);
      }
    },
    emitServerInfo(nextFeatures?: ServerInfoStatusPayload["features"]) {
      serverInfo = {
        status: "server_info",
        serverId: "srv-test",
        hostname: "test-host",
        version: "0.18.0",
        ...(nextFeatures ? { features: nextFeatures } : {}),
      };
      const message: Extract<SessionOutboundMessage, { type: "status" }> = {
        type: "status",
        payload: serverInfo,
      };
      for (const listener of statusListeners) {
        listener(message);
      }
    },
  };
}

function makeSettingsEnv(initialNotifications?: NotificationPreferences): {
  queryClient: QueryClient;
  settingsDeps: SettingsDeps;
} {
  const queryClient = new QueryClient();
  const settings: AppSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    ...(initialNotifications ? { notifications: initialNotifications } : {}),
  };
  queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, settings);
  const settingsDeps: SettingsDeps = {
    storage: createInMemoryKeyValueStorage(),
    desktop: createFakeDesktopBridge(),
  };
  return { queryClient, settingsDeps };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startSubscription push notification preferences sync", () => {
  it("sends current notification preferences on connect when pushNotificationPreferences is supported", async () => {
    const fake = createFakePushClient({
      isConnected: true,
      pushNotificationPreferences: true,
    });
    const { queryClient, settingsDeps } = makeSettingsEnv();

    const stop = startSubscription({
      client: fake.client,
      serverId: "srv-test",
      queryClient,
      settingsDeps,
      resolveToken: async () => "ExponentPushToken[device-1]",
    });

    await flushMicrotasks();

    expect(fake.registrations).toEqual([
      {
        token: "ExponentPushToken[device-1]",
        preferencesProvided: true,
        preferences: DEFAULT_NOTIFICATION_PREFERENCES,
      },
    ]);

    stop();
  });

  it("re-syncs preferences immediately when AppSettings.notifications changes while connected", async () => {
    const fake = createFakePushClient({
      isConnected: true,
      pushNotificationPreferences: true,
    });
    const { queryClient, settingsDeps } = makeSettingsEnv();

    const stop = startSubscription({
      client: fake.client,
      serverId: "srv-test",
      queryClient,
      settingsDeps,
      resolveToken: async () => "ExponentPushToken[device-1]",
    });

    await flushMicrotasks();
    expect(fake.registrations).toHaveLength(1);

    const updatedPreferences: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.events,
        agentFinished: true,
      },
      plugins: {
        enabled: true,
        muted: ["ci-watchdog"],
      },
    };

    await saveAppSettings({
      queryClient,
      deps: settingsDeps,
      updates: { notifications: updatedPreferences },
    });

    expect(fake.registrations).toHaveLength(2);
    expect(fake.registrations[1]).toEqual({
      token: "ExponentPushToken[device-1]",
      preferencesProvided: true,
      preferences: updatedPreferences,
    });

    stop();
  });

  it("omits preferences against older daemons without pushNotificationPreferences", async () => {
    const fake = createFakePushClient({
      isConnected: true,
      pushNotificationPreferences: undefined,
    });
    const { queryClient, settingsDeps } = makeSettingsEnv();

    const stop = startSubscription({
      client: fake.client,
      serverId: "srv-test",
      queryClient,
      settingsDeps,
      resolveToken: async () => "ExponentPushToken[legacy-device]",
    });

    await flushMicrotasks();

    expect(fake.registrations).toEqual([
      {
        token: "ExponentPushToken[legacy-device]",
        preferencesProvided: false,
        preferences: undefined,
      },
    ]);

    await saveAppSettings({
      queryClient,
      deps: settingsDeps,
      updates: {
        notifications: {
          ...DEFAULT_NOTIFICATION_PREFERENCES,
          enabled: false,
        },
      },
    });

    for (const registration of fake.registrations) {
      expect(registration.preferencesProvided).toBe(false);
      expect(registration.preferences).toBeUndefined();
    }

    stop();
  });

  it("re-syncs preferences on reconnect and when server_info upgrades pushNotificationPreferences", async () => {
    const fake = createFakePushClient({
      isConnected: true,
      pushNotificationPreferences: false,
    });
    const { queryClient, settingsDeps } = makeSettingsEnv();

    const stop = startSubscription({
      client: fake.client,
      serverId: "srv-test",
      queryClient,
      settingsDeps,
      resolveToken: async () => "ExponentPushToken[upgrade-device]",
    });

    await flushMicrotasks();

    expect(fake.registrations).toEqual([
      {
        token: "ExponentPushToken[upgrade-device]",
        preferencesProvided: false,
        preferences: undefined,
      },
    ]);

    fake.emitServerInfo({ pushNotificationPreferences: true });

    expect(fake.registrations).toHaveLength(2);
    expect(fake.registrations[1]).toEqual({
      token: "ExponentPushToken[upgrade-device]",
      preferencesProvided: true,
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    });

    fake.setConnected(false);
    fake.setConnected(true);

    expect(fake.registrations).toHaveLength(3);
    expect(fake.registrations[2]).toEqual({
      token: "ExponentPushToken[upgrade-device]",
      preferencesProvided: true,
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    });

    stop();

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
  Platform: { OS: "android", select: (values: Record<string, unknown>) => values.android ?? values.default },
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
