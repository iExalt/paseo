import Constants from "expo-constants";
import { Platform } from "react-native";
import { readAgentSwitch } from "@/diagnostics/agent-switches";

export const PREFERENCES_MIGRATION_BRIDGE_VERSION_CODE = 11001;

export type PreferencesMigrationMode = "bridge" | "receiver";

export function resolvePreferencesMigrationMode(input: {
  platform: string;
  extra: Record<string, unknown> | undefined;
  packageName: string | undefined;
  versionCode: number | undefined;
}): PreferencesMigrationMode | null {
  if (input.platform !== "android") return null;
  if (
    input.extra?.preferencesMigrationBridge === true &&
    input.packageName === "sh.paseo.debug" &&
    input.versionCode === PREFERENCES_MIGRATION_BRIDGE_VERSION_CODE
  )
    return "bridge";
  if (
    input.extra?.preferencesMigrationReceiver === true &&
    input.packageName === "sh.paseo.iexalt"
  ) {
    return "receiver";
  }
  return null;
}

// Repeated here, not imported, so bundles without the flag still fold it away.
const SWITCHES_ENABLED = process.env.EXPO_PUBLIC_PASEO_AGENT_SWITCHES === "1";

export function preferencesMigrationMode(): PreferencesMigrationMode | null {
  // The `transfer` agent switch shows the row on any platform for UI checks; the transfer itself
  // still needs the real packages.
  const forced = SWITCHES_ENABLED ? readAgentSwitch("transfer") : undefined;
  if (forced) return forced;
  const config = Constants.expoConfig;
  return resolvePreferencesMigrationMode({
    platform: Platform.OS,
    extra: config?.extra,
    packageName: config?.android?.package,
    versionCode: config?.android?.versionCode,
  });
}
