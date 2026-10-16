import type { SettingsSectionSlug } from "@/utils/host-routes";

/**
 * Settings sections that only some runtimes show. `desktop` means the Electron app;
 * `web` means any web runtime, Electron included. Every entry needs a matching
 * classification in the platform parity manifest.
 */
export const SETTINGS_SECTION_GATES: Partial<Record<SettingsSectionSlug, "desktop" | "web">> = {
  browser: "desktop",
  editor: "web",
  shortcuts: "desktop",
  integrations: "desktop",
  notifications: "desktop",
  permissions: "desktop",
};

export function isSettingsSectionAvailable(
  section: SettingsSectionSlug,
  runtime: { isDesktopApp: boolean; isWeb: boolean },
): boolean {
  const gate = SETTINGS_SECTION_GATES[section];
  if (gate === "desktop") return runtime.isDesktopApp;
  if (gate === "web") return runtime.isWeb;
  return true;
}
