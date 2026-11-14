const DENIED_NOTIFICATION_PERMISSION = {
  canAskAgain: false,
  expires: "never",
  granted: false,
  status: "denied",
} as const;

export const PermissionStatus = {
  DENIED: "denied",
  GRANTED: "granted",
  UNDETERMINED: "undetermined",
} as const;

export const AndroidImportance = { DEFAULT: 3 } as const;

export async function getPermissionsAsync() {
  return DENIED_NOTIFICATION_PERMISSION;
}

export async function requestPermissionsAsync() {
  return DENIED_NOTIFICATION_PERMISSION;
}

export async function getExpoPushTokenAsync() {
  return { data: "" };
}

export async function setNotificationChannelAsync() {
  return null;
}

export function setNotificationHandler(): void {}

export function addNotificationResponseReceivedListener() {
  return { remove() {} };
}

export async function getLastNotificationResponseAsync() {
  return null;
}

export function clearLastNotificationResponse(): void {}

// Nothing is ever presented without a push token; these keep notification dismissal from throwing.
export const getPresentedNotificationsAsync =
  (async () => []) satisfies typeof import("expo-notifications").getPresentedNotificationsAsync;

export const dismissNotificationAsync = (async () =>
  undefined) satisfies typeof import("expo-notifications").dismissNotificationAsync;

export const addNotificationReceivedListener = (() => ({
  remove() {},
})) satisfies typeof import("expo-notifications").addNotificationReceivedListener;
