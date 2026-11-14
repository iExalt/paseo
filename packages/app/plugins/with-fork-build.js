const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");
const { validateForkGoogleServicesConfig } = require("../app-variant");

const unsupportedForkIos =
  "Fork iOS builds are not supported. Choose an approved Apple identity and distribution contract before enabling iOS; do not submit the fork as sh.paseo.";

function assertForkBuildPlatform(appVariant, platform) {
  if (appVariant === "fork" && platform === "ios") {
    throw new Error(unsupportedForkIos);
  }
}

function resolveForkGoogleServicesFile(configuredPath, expectedProjectId) {
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw new Error(
      "APP_VARIANT=fork requires GOOGLE_SERVICES_FILE_FORK to name an absolute decrypted JSON path.",
    );
  }

  if (!expectedProjectId) {
    throw new Error("APP_VARIANT=fork requires FIREBASE_PROJECT_ID_FORK.");
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
  } catch {
    throw new Error(
      "GOOGLE_SERVICES_FILE_FORK must point to a readable Firebase Android JSON file.",
    );
  }

  validateForkGoogleServicesConfig(config, expectedProjectId);
  return configuredPath;
}

function withForkBuild(config) {
  const expectedProjectId = process.env.FIREBASE_PROJECT_ID_FORK?.trim();
  // Expo evaluates config before local prebuild knows its platform. Validate only Android mods.
  config = withAndroidManifest(config, (modConfig) => {
    resolveForkGoogleServicesFile(modConfig.android?.googleServicesFile, expectedProjectId);
    return modConfig;
  });
  // expo.platforms warns rather than refusing an explicitly requested iOS prebuild.
  return withInfoPlist(config, () => {
    throw new Error(unsupportedForkIos);
  });
}

module.exports = { withForkBuild, assertForkBuildPlatform };
