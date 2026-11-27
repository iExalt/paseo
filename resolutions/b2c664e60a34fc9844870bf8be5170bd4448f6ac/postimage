import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { QueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  loadAppSettingsFromStorage as loadAppSettingsFromStoragePure,
  type AppSettings,
  type SettingsDeps,
} from "@/hooks/use-settings/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { z } from "zod";
import { readValidatedString } from "@/storage/validated-storage";
import { readAgentSwitch } from "@/diagnostics/agent-switches";
import { agentLog, describeError } from "@/utils/agent-log";
import {
  PUSH_CHANNEL_ID,
  provideReregister,
  setPushRegistrationStatus,
  usePushRegistrationStore,
} from "../registration";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";

const STORAGE_PREFIX = "@paseo:expo-push-token:";
const ExpoPushTokenSchema = z.string().trim().min(1);

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function getExpoProjectId(): string | null {
  const fromEas = ExpoPushTokenSchema.safeParse(Constants.easConfig?.projectId);
  if (fromEas.success) return fromEas.data;
  const fromExtra = ExpoPushTokenSchema.safeParse(Constants.expoConfig?.extra?.eas?.projectId);
  return fromExtra.success ? fromExtra.data : null;
}

// Repeated here, not imported, so bundles without the flag still fold it away.
const SWITCHES_ENABLED = process.env.EXPO_PUBLIC_PASEO_AGENT_SWITCHES === "1";

async function ensurePushPermission(prompt: boolean): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!prompt || !existing.canAskAgain) return false;
  if (SWITCHES_ENABLED && readAgentSwitch("notifications") === "skip") {
    agentLog("push", "prompt", { status: "skipped", reason: "debug-switch" });
    return false;
  }
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

let loggedFirebaseMissing = false;
// Messages from builds with no google-services file. Other Firebase errors are real failures.
const FIREBASE_NOT_CONFIGURED = /googleServicesFile|Default FirebaseApp is not initialized/;

// Builds without a google-services file (local APKs, the tablet harness) fail on every connect.
// Say so once per session instead of a warning with a stack each time.
function logRegistrationFailure(error: unknown): void {
  if (FIREBASE_NOT_CONFIGURED.test(describeError(error))) {
    if (loggedFirebaseMissing) return;
    loggedFirebaseMissing = true;
    agentLog("push", "register", { status: "unavailable", reason: "firebase-not-configured" });
    return;
  }
  console.warn("[PushNotifications] Failed to register push token", error);
}

type ResolvedToken = { token: string } | { token: null; reason: "no-permission" | "no-token" };

function resolved(token: string | null): ResolvedToken {
  return token ? { token } : { token: null, reason: "no-token" };
}

async function resolveToken(serverId: string, prompt: boolean): Promise<ResolvedToken> {
  const key = storageKey(serverId);
  const cached = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (!(await ensurePushPermission(prompt))) {
    await AsyncStorage.removeItem(key);
    return { token: null, reason: "no-permission" };
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
    return resolved(cached);
  }

  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = result.data.trim();
  if (!token) return resolved(cached);
  await AsyncStorage.setItem(key, token);
  return { token };
}

async function loadInitialAppSettings(settingsDeps?: SettingsDeps): Promise<AppSettings> {
  if (settingsDeps) {
    return loadAppSettingsFromStoragePure(settingsDeps);
  }
  const { loadAppSettingsFromStorage } = await import("@/hooks/use-settings");
  return loadAppSettingsFromStorage();
}

function readCachedPreferences(queryClient: QueryClient): NotificationPreferences | null {
  const cached = queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
  if (!cached) {
    return null;
  }
  return normalizeNotificationPreferences(cached.notifications);
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  const { serverId } = input;
  let stopped = false;
  let token: string | null = null;
  const queryClient = input.queryClient ?? appQueryClient;
  const initialCached = readCachedPreferences(queryClient);
  let preferences = initialCached ?? DEFAULT_NOTIFICATION_PREFERENCES;
  let preferencesReady = initialCached !== null;
  let lastRegisteredSignature: string | null = null;
  const testResolveToken = input.resolveToken;
  const resolveSubscriptionToken = testResolveToken
    ? async (id: string): Promise<ResolvedToken> => resolved(await testResolveToken(id))
    : resolveToken;

  const register = () => {
    if (stopped || !token) return;
    if (!input.client.isConnected) {
      setPushRegistrationStatus(serverId, "not-connected");
      return;
    }
    // COMPAT(pushNotificationPreferences): added in v0.18.0, remove gate after 2027-06-01.
    const supportsPreferences =
      input.client.getLastServerInfoMessage()?.features?.pushNotificationPreferences === true;
    if (supportsPreferences && !preferencesReady) return;
    const signature = supportsPreferences ? `${token}:${JSON.stringify(preferences)}` : `${token}:legacy`;
    if (signature !== lastRegisteredSignature) {
      lastRegisteredSignature = signature;
      if (supportsPreferences) input.client.registerPushToken(token, preferences);
      else input.client.registerPushToken(token);
    }
    setPushRegistrationStatus(serverId, "sent");
  };

  const resolve = ({ prompt }: { prompt: boolean }) => {
    setPushRegistrationStatus(serverId, "pending");
    void resolveSubscriptionToken(serverId, prompt)
      .then((result) => {
        if (stopped) return undefined;
        token = result.token;
        if (result.token === null) setPushRegistrationStatus(serverId, result.reason);
        register();
        return undefined;
      })
      .catch((error) => {
        if (!stopped) setPushRegistrationStatus(serverId, "failed");
        logRegistrationFailure(error);
      });
  };

  if (!preferencesReady) {
    void loadInitialAppSettings(input.settingsDeps)
      .then((loaded) => {
        if (stopped) return undefined;
        const latestCached = readCachedPreferences(queryClient);
        preferences = latestCached ?? normalizeNotificationPreferences(loaded.notifications);
        preferencesReady = true;
        register();
        return undefined;
      })
      .catch(() => {
        if (stopped) return undefined;
        preferencesReady = true;
        register();
        return undefined;
      });
  }

  resolve({ prompt: true });
  const stopReregister = provideReregister(serverId, () => {
    lastRegisteredSignature = null;
    resolve({ prompt: true });
  });
  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    lastRegisteredSignature = null;
    if (state.status === "connected") register();
  });
  const unsubscribeStatus =
    input.client.on?.("status", (message) => {
      if (message.type === "status" && parseServerInfoStatusPayload(message.payload)) {
        register();
      }
    }) ?? (() => undefined);

  const unsubscribeQueryCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== APP_SETTINGS_QUERY_KEY[0]) {
      return;
    }
    const nextPreferences = readCachedPreferences(queryClient);
    if (!nextPreferences) {
      return;
    }
    preferences = nextPreferences;
    preferencesReady = true;
    register();
  });


  // Notification access is usually granted in system settings, outside the app. Only
  // read it here: Android's prompt pauses the app, so prompting on resume would loop.
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active" && usePushRegistrationStore.getState()[serverId] === "no-permission") {
      resolve({ prompt: false });
    }
  });

  return () => {
    stopped = true;
    stopReregister();
    unsubscribe();
    unsubscribeStatus();
    unsubscribeQueryCache();
    appState.remove();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  const key = storageKey(input.serverId);
  const token = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (
    token &&
    input.client?.isConnected &&
    input.client.getLastServerInfoMessage()?.features?.pushTokenRevocation === true
  ) {
    try {
      await input.client.unregisterPushToken(token);
    } catch (error) {
      console.warn("[PushNotifications] Failed to revoke push token", error);
    }
  }
  await AsyncStorage.removeItem(key);
}
