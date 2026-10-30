import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { z } from "zod";
import { readValidatedString } from "@/storage/validated-storage";
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

async function ensurePushPermission(prompt: boolean): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!prompt || !existing.canAskAgain) return false;
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

export function startSubscription(input: StartPushNotificationsInput): () => void {
  const { serverId } = input;
  let stopped = false;
  let token: string | null = null;
  const register = () => {
    if (stopped || !token) return;
    if (!input.client.isConnected) {
      setPushRegistrationStatus(serverId, "not-connected");
      return;
    }
    input.client.registerPushToken(token);
    setPushRegistrationStatus(serverId, "sent");
  };
  const resolve = ({ prompt }: { prompt: boolean }) => {
    setPushRegistrationStatus(serverId, "pending");
    void resolveToken(serverId, prompt)
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

  resolve({ prompt: true });
  const stopReregister = provideReregister(serverId, () => resolve({ prompt: true }));
  const unsubscribe = input.client.subscribeConnectionStatus(() => register());
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
