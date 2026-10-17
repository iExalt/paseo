import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import * as Notifications from "expo-notifications";
import { Linking } from "react-native";
import { isFdroidBuild } from "@/constants/build-profile";
import type {
  DesktopPermissionKind,
  DesktopPermissionSnapshot,
  DesktopPermissionStatus,
} from "@/desktop/permissions/desktop-permissions";
import { i18n } from "@/i18n/i18next";
import {
  mapNativePermission,
  type NativePermissionDetails,
  type NativePermissionResponse,
} from "./native-permission-status";

export function shouldShowPermissionSettings(): boolean {
  return true;
}

function details(kind: DesktopPermissionKind): NativePermissionDetails {
  return {
    granted: i18n.t(`nativePermissions.${kind}.granted`),
    prompt: i18n.t(`nativePermissions.${kind}.prompt`),
    notGranted: i18n.t(`nativePermissions.${kind}.notGranted`),
    blocked: i18n.t(`nativePermissions.${kind}.blocked`),
    unavailable: i18n.t(`nativePermissions.${kind}.unavailable`),
  };
}

// F-Droid builds replace expo-notifications with a stub that always answers denied.
function hasCapability(kind: DesktopPermissionKind): boolean {
  return kind !== "notifications" || !isFdroidBuild;
}

async function ask(
  kind: DesktopPermissionKind,
  query: () => Promise<NativePermissionResponse>,
): Promise<DesktopPermissionStatus> {
  if (!hasCapability(kind)) return mapNativePermission(null, details(kind));
  try {
    return mapNativePermission(await query(), details(kind));
  } catch (error) {
    console.warn(`[Permissions] Failed to read ${kind} permission`, error);
    return mapNativePermission(null, details(kind));
  }
}

function getStatus(kind: DesktopPermissionKind): Promise<DesktopPermissionStatus> {
  return ask(
    kind,
    kind === "notifications" ? Notifications.getPermissionsAsync : getRecordingPermissionsAsync,
  );
}

export async function getPermissionSnapshot(): Promise<DesktopPermissionSnapshot> {
  const [notifications, microphone] = await Promise.all([
    getStatus("notifications"),
    getStatus("microphone"),
  ]);
  return { checkedAt: Date.now(), notifications, microphone };
}

/** Shows the OS prompt, or opens system settings once the OS stops asking. */
export async function requestPermission(input: {
  kind: DesktopPermissionKind;
}): Promise<DesktopPermissionStatus> {
  const current = await getStatus(input.kind);
  if (current.action === "open-settings") {
    await Linking.openSettings();
    return current;
  }
  if (current.action !== "request") return current;
  return ask(
    input.kind,
    input.kind === "notifications"
      ? Notifications.requestPermissionsAsync
      : requestRecordingPermissionsAsync,
  );
}
