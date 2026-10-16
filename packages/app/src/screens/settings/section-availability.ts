import type { SettingsSectionSlug } from "@/utils/host-routes";

/**
 * Settings sections that only some runtimes show. `desktop` means the Electron app;
 * `web` means any web runtime, Electron included; `desktop-or-native` hides the
 * section only in a plain browser. Every entry needs a matching classification in
 * the platform parity manifest.
 */
export type SettingsSectionGate = "desktop" | "web" | "desktop-or-native";

export const SETTINGS_SECTION_GATES: Partial<Record<SettingsSectionSlug, SettingsSectionGate>> = {
  browser: "desktop",
  editor: "web",
  shortcuts: "desktop",
  integrations: "desktop",
  notifications: "desktop-or-native",
  permissions: "desktop-or-native",
};

export function isSettingsSectionAvailable(
  section: SettingsSectionSlug,
  runtime: { isDesktopApp: boolean; isWeb: boolean },
): boolean {
  const gate = SETTINGS_SECTION_GATES[section];
  if (gate === "desktop") return runtime.isDesktopApp;
  if (gate === "web") return runtime.isWeb;
  if (gate === "desktop-or-native") return runtime.isDesktopApp || !runtime.isWeb;
  return true;
}
