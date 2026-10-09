// Install runtime polyfills before any other module evaluates. Keep this the first import.
// oxlint-disable-next-line import/no-unassigned-import -- Polyfills install on import.
import "./src/polyfills/install-early";

// Configure Unistyles before Expo Router pulls in any components using StyleSheet.
import "./src/styles/unistyles";
// oxlint-disable-next-line import/no-unassigned-import -- Preserve Expo's entry side effects.
import "@expo/metro-runtime";
// oxlint-disable-next-line import/no-unassigned-import -- Preserve Expo's entry side effects.
import "expo-router/build/fast-refresh";
import { renderRootComponent } from "expo-router/build/renderRootComponent";
import { preferencesMigrationMode } from "./src/android/preferences-migration/mode";

if (preferencesMigrationMode()) {
  const { PreferencesMigrationStartup } =
    require("./src/android/preferences-migration/startup") as typeof import("./src/android/preferences-migration/startup");
  renderRootComponent(PreferencesMigrationStartup);
} else {
  // Keep the normal application path synchronous and unchanged.
  const { startWatchdog } = require("./src/watchdog") as typeof import("./src/watchdog");
  const { RootApp } = require("./src/root-app") as typeof import("./src/root-app");
  startWatchdog();
  renderRootComponent(RootApp);
}
