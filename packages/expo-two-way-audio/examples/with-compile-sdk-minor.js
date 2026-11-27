const configureCompileSdk = require("../../app/plugins/configure-compile-sdk");

module.exports = function withCompileSdkMinor(config) {
  const { withAppBuildGradle } = require(
    require.resolve("expo/config-plugins", { paths: [config._internal.projectRoot] }),
  );
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = configureCompileSdk(mod.modResults.contents);
    return mod;
  });
};
