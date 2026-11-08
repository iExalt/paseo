const fs = require("node:fs/promises");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const distributionUrl = "https\\://services.gradle.org/distributions/gradle-9.8.2-bin.zip";
const distributionSha256Sum = "21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607";

function configureGradleWrapper(source) {
  if (!/^distributionUrl=.+$/m.test(source)) {
    throw new Error("Could not find the Android Gradle wrapper distribution URL");
  }
  const configured = source
    .replace(/^distributionUrl=.+$/m, `distributionUrl=${distributionUrl}`)
    .replace(/^distributionSha256Sum=.*\r?\n?/gm, "");
  return `${configured.trimEnd()}\ndistributionSha256Sum=${distributionSha256Sum}\n`;
}

function withAndroidGradle(config) {
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const file = path.join(
        modConfig.modRequest.platformProjectRoot,
        "gradle/wrapper/gradle-wrapper.properties",
      );
      await fs.writeFile(file, configureGradleWrapper(await fs.readFile(file, "utf8")));
      return modConfig;
    },
  ]);
}

module.exports = withAndroidGradle;
module.exports.configureGradleWrapper = configureGradleWrapper;
