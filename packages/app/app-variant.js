const { getRequiredAndroidVersionCode } = require("./native-release-version");

const variants = {
  production: {
    name: "Paseo",
    iosBundleIdentifier: "sh.paseo",
    androidPackage: "sh.paseo",
  },
  development: {
    name: "Paseo Debug",
    iosBundleIdentifier: "sh.paseo.debug",
    androidPackage: "sh.paseo.debug",
  },
  fork: {
    name: "Paseo iExalt",
    iosBundleIdentifier: "sh.paseo",
    androidPackage: "sh.paseo.iexalt",
  },
};

function resolveAppVariant(appVariant, defaultAndroidVersionCode, forkAndroidVersionCode) {
  const variantName = Object.hasOwn(variants, appVariant) ? appVariant : "production";
  const variant = variants[variantName];

  return {
    ...variant,
    androidVersionCode:
      variantName === "fork"
        ? getRequiredAndroidVersionCode(forkAndroidVersionCode)
        : defaultAndroidVersionCode,
  };
}

function validateForkGoogleServicesConfig(config, expectedProjectId) {
  const projectId = config?.project_info?.project_id;
  const expectedId = typeof expectedProjectId === "string" ? expectedProjectId.trim() : "";
  const hasForkAndroidClient =
    Array.isArray(config?.client) &&
    config.client.some(
      (client) => client?.client_info?.android_client_info?.package_name === "sh.paseo.iexalt",
    );

  if (
    !expectedId ||
    typeof projectId !== "string" ||
    projectId !== expectedId ||
    !hasForkAndroidClient
  ) {
    throw new Error(
      "Firebase Android config must match the expected project and sh.paseo.iexalt client.",
    );
  }

  return true;
}

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
