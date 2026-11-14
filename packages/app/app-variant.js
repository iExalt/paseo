const { getForkAndroidVersionCode } = require("./native-release-version");
function resolveAppVariant(appVariant, defaultAndroidVersionCode, version, forkAndroidVersionCode) {
        ? getForkAndroidVersionCode(version, forkAndroidVersionCode)
function resolvePreferencesMigrationBridge(appVariant, enabled) {
  if (enabled && appVariant !== "development") {
    throw new Error("PASEO_PREFS_MIGRATION_BRIDGE=1 is valid only with APP_VARIANT=development.");
  }
  return appVariant === "development" && enabled;
}

module.exports = {
  resolveAppVariant,
  resolvePreferencesMigrationBridge,
  validateForkGoogleServicesConfig,
};
