const fs = require("node:fs/promises");
const path = require("node:path");
const {
  withDangerousMod,
  withGradleProperties,
  withProjectBuildGradle,
  withAppBuildGradle,
} = require("expo/config-plugins");

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

function configureAndroidBuildGradle(source) {
  const dependency = /classpath\(['"]com\.android\.tools\.build:gradle(?::[^'"]+)?['"]\)/;
  if (!dependency.test(source)) {
    throw new Error("Could not find the Android Gradle plugin dependency");
  }
  return source.replace(dependency, "classpath('com.android.tools.build:gradle:9.2.1')");
}

function configureAndroidAppBuildGradle(source) {
  if (!/proguard-android(?:-optimize)?\.txt/.test(source)) {
    throw new Error("Could not find the Android app's default ProGuard configuration");
  }
  return source.replaceAll("proguard-android.txt", "proguard-android-optimize.txt");
}

function withAndroidGradle(config) {
  config = withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = configureAndroidAppBuildGradle(modConfig.modResults.contents);
    return modConfig;
  });
  config = withProjectBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = configureAndroidBuildGradle(modConfig.modResults.contents);
    return modConfig;
  });
  config = withGradleProperties(config, (modConfig) => {
    // shortcut: Expo SDK 57 needs AGP 9 legacy flags; remove after its AGP 9 migration.
    for (const key of [
      "android.builtInKotlin",
      "android.newDsl",
      // CI and test:android require the release JVM test tasks as well as debug.
      "android.onlyEnableUnitTestForTheTestedBuildType",
    ]) {
      const existing = modConfig.modResults.find(
        (property) => property.type === "property" && property.key === key,
      );
      if (existing) existing.value = "false";
      else modConfig.modResults.push({ type: "property", key, value: "false" });
    }
    return modConfig;
  });
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
module.exports.configureAndroidBuildGradle = configureAndroidBuildGradle;
module.exports.configureAndroidAppBuildGradle = configureAndroidAppBuildGradle;
