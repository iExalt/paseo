import type { DesktopPermissionStatus } from "@/desktop/permissions/desktop-permissions";

/** The shape expo-notifications and expo-audio return for a permission. */
export interface NativePermissionResponse {
  status: string;
  canAskAgain: boolean;
  /** iOS notification detail; provisional and ephemeral authorizations deliver notifications. */
  ios?: { status?: number };
}

// expo-notifications IosAuthorizationStatus.PROVISIONAL and EPHEMERAL.
const IOS_DELIVERING_STATUSES = new Set([3, 4]);

/** Copy for each mapped state, so the mapping stays free of i18n. */
export type NativePermissionDetails = Record<
  "granted" | "prompt" | "notGranted" | "blocked" | "unavailable",
  string
>;

/**
 * Maps a native permission response to the status the permission rows render, with
 * the action the row's button takes. `null` means the query failed or the build has
 * no such capability.
 */
export function mapNativePermission(
  response: NativePermissionResponse | null,
  details: NativePermissionDetails,
): DesktopPermissionStatus {
  if (response === null) {
    return { state: "unavailable", detail: details.unavailable, action: "none" };
  }
  if (response.status === "granted" || IOS_DELIVERING_STATUSES.has(response.ios?.status ?? -1)) {
    return { state: "granted", detail: details.granted, action: "none" };
  }
  if (response.status === "undetermined") {
    return { state: "prompt", detail: details.prompt, action: "request" };
  }
  if (response.canAskAgain) {
    return { state: "not-granted", detail: details.notGranted, action: "request" };
  }
  return { state: "denied", detail: details.blocked, action: "open-settings" };
}
