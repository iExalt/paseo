import type { SettingsSectionSlug } from "@/utils/host-routes";

/**
 * Settings sections that only some runtimes show. `desktop` means the Electron app;
 * `web` hides the section on native; `desktop-or-native` hides the section only in a plain browser;
 * `desktop-or-native-shortcuts` shows it on native only while keyboard shortcuts are
 * available there (wide layout, hardware keyboard). Notification preferences are
 * available where the app can deliver an OS notification. Every entry needs a matching
 * classification in the platform parity manifest.
 */
export type SettingsSectionGate =
  | "desktop"
  | "web"
  | "desktop-or-native"
  | "desktop-or-native-shortcuts"
  | "notification-preferences";

export const SETTINGS_SECTION_GATES: Partial<Record<SettingsSectionSlug, SettingsSectionGate>> = {
  shortcuts: "desktop-or-native-shortcuts",
  notifications: "notification-preferences",
};

export function isSettingsSectionAvailable(
  section: SettingsSectionSlug,
  runtime: {
    isDesktopApp: boolean;
    isWeb: boolean;
    keyboardShortcutsAvailable: boolean;
    browserNotificationsAvailable: boolean;
  },
): boolean {
  const gate = SETTINGS_SECTION_GATES[section];
  if (gate === "desktop") return runtime.isDesktopApp;
  if (gate === "web") return runtime.isWeb;
  if (gate === "desktop-or-native") return runtime.isDesktopApp || !runtime.isWeb;
  if (gate === "notification-preferences") {
    return runtime.isDesktopApp || !runtime.isWeb || runtime.browserNotificationsAvailable;
  }
  if (gate === "desktop-or-native-shortcuts") {
    return runtime.isDesktopApp || (!runtime.isWeb && runtime.keyboardShortcutsAvailable);
  }
  return true;
}
