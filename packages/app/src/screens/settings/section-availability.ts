import type { SettingsSectionSlug } from "@/utils/host-routes";

/**
 * Settings sections that only some runtimes show. `desktop` means the Electron app;
 * `desktop-or-native` hides the section only in a plain browser;
 * `desktop-or-native-shortcuts` shows it on native only while keyboard shortcuts are
 * available there (wide layout, hardware keyboard). Every entry needs a matching
 * classification in the platform parity manifest.
 */
export type SettingsSectionGate = "desktop" | "desktop-or-native" | "desktop-or-native-shortcuts";

export const SETTINGS_SECTION_GATES: Partial<Record<SettingsSectionSlug, SettingsSectionGate>> = {
  browser: "desktop-or-native",
  shortcuts: "desktop-or-native-shortcuts",
  integrations: "desktop",
  notifications: "desktop-or-native",
  permissions: "desktop-or-native",
};

export function isSettingsSectionAvailable(
  section: SettingsSectionSlug,
  runtime: { isDesktopApp: boolean; isWeb: boolean; keyboardShortcutsAvailable: boolean },
): boolean {
  const gate = SETTINGS_SECTION_GATES[section];
  if (gate === "desktop") return runtime.isDesktopApp;
  if (gate === "desktop-or-native") return runtime.isDesktopApp || !runtime.isWeb;
  if (gate === "desktop-or-native-shortcuts") {
    return runtime.isDesktopApp || (!runtime.isWeb && runtime.keyboardShortcutsAvailable);
  }
  return true;
}
