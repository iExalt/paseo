import Constants from "expo-constants";
import { Platform } from "react-native";

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

export function preferencesMigrationMode(): PreferencesMigrationMode | null {
  const config = Constants.expoConfig;
  return resolvePreferencesMigrationMode({
    platform: Platform.OS,
    extra: config?.extra,
    packageName: config?.android?.package,
    versionCode: config?.android?.versionCode,
  });
}
