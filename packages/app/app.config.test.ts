import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// Load the copies the Expo CLI uses for prebuild, not older hoisted ones.
const requireFromExpo = createRequire(require.resolve("expo/package.json"));
const requireFromExpoCli = createRequire(requireFromExpo.resolve("@expo/cli/package.json"));
const { getPrebuildConfigAsync } = requireFromExpoCli("@expo/prebuild-config");
const { compileModsAsync } = requireFromExpoCli(
  "@expo/config-plugins/build/plugins/mod-compiler.js",
);

interface ManifestEntry {
  $: Record<string, string>;
}

const originalFdroidFlag = process.env.PASEO_FDROID_BUILD;

async function resolveAndroidManifest() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest;
}

describe("Android app config", () => {
  afterEach(() => {
    if (originalFdroidFlag === undefined) {
      delete process.env.PASEO_FDROID_BUILD;
    } else {
      process.env.PASEO_FDROID_BUILD = originalFdroidFlag;
    }
  });

  it.each([
    ["Google Play", "0"],
    ["F-Droid", "1"],
  ])(
    "%s build installs on devices without a camera",
    async (_build, fdroidFlag) => {
      process.env.PASEO_FDROID_BUILD = fdroidFlag;
      const manifest = await resolveAndroidManifest();
      const permissions = (manifest["uses-permission"] ?? []).map(
        (entry: ManifestEntry) => entry.$["android:name"],
      );
      const features = (manifest["uses-feature"] ?? []).map((entry: ManifestEntry) => entry.$);

      expect(permissions).toContain("android.permission.CAMERA");
      expect(features).toEqual(
        expect.arrayContaining([
          { "android:name": "android.hardware.camera", "android:required": "false" },
          { "android:name": "android.hardware.camera.autofocus", "android:required": "false" },
        ]),
      );
    },
    30_000,
  );
});

it("follows system rotation on Android", async () => {
  const manifest = await resolveAndroidManifest();
  const activity = manifest.application[0].activity.find(
    (entry: ManifestEntry) => entry.$["android:name"] === ".MainActivity",
  );
  expect(activity.$["android:screenOrientation"]).toBe("unspecified");
}, 30_000);

it("allows all orientations on iPhone and iPad", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "paseo-ios-config-"));
  try {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    await compileModsAsync(exp, {
      projectRoot: root,
      introspect: true,
      platforms: ["ios"],
      assertMissingModProviders: false,
    });
    const plist = exp._internal.modResults.ios.infoPlist;
    const orientations = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
    expect(plist.UISupportedInterfaceOrientations).toEqual(orientations);
    expect(plist["UISupportedInterfaceOrientations~ipad"]).toEqual(orientations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

const {
  configureGradleWrapper,
  configureAndroidBuildGradle,
  configureAndroidAppBuildGradle,
} = require("./plugins/with-android-gradle");

describe("withAndroidGradle", () => {
  it("generates the compatibility flags and retains release JVM test tasks", async () => {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
    await compileModsAsync(exp, {
      projectRoot: __dirname,
      introspect: true,
      platforms: ["android"],
      assertMissingModProviders: false,
    });
    const properties = exp._internal.modResults.android.gradleProperties;
    for (const key of [
      "android.builtInKotlin",
      "android.newDsl",
      "android.onlyEnableUnitTestForTheTestedBuildType",
    ]) {
      expect(properties.find((property: { key: string }) => property.key === key)?.value).toBe(
        "false",
      );
    }
  }, 30_000);

  it("uses the default ProGuard file supported by AGP 9", () => {
    const configured = configureAndroidAppBuildGradle(
      "proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'",
    );
    expect(configured).toBe(
      "proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'",
    );
    expect(configureAndroidAppBuildGradle(configured)).toBe(configured);
    expect(() => configureAndroidAppBuildGradle("android {}\n")).toThrow("ProGuard");
  });
  it("pins AGP 9 without changing other build dependencies", () => {
    const configured = configureAndroidBuildGradle(
      "classpath('com.android.tools.build:gradle')\nclasspath('com.facebook.react:react-native-gradle-plugin')\n",
    );
    expect(configured).toBe(
      "classpath('com.android.tools.build:gradle:9.2.1')\nclasspath('com.facebook.react:react-native-gradle-plugin')\n",
    );
    expect(configureAndroidBuildGradle(configured)).toBe(configured);
    expect(() => configureAndroidBuildGradle("dependencies {}\n")).toThrow("plugin dependency");
  });
  it("pins a Java 27 compatible distribution and its checksum, preserving wrapper settings", () => {
    const configured = configureGradleWrapper(
      "distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-bin.zip\nnetworkTimeout=10000\ndistributionSha256Sum=old\n",
    );
    expect(configured).toContain(
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.8.2-bin.zip\n",
    );
    expect(configured).toContain(
      "distributionSha256Sum=21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607\n",
    );
    expect(configured).toContain("distributionBase=GRADLE_USER_HOME\n");
    expect(configured).toContain("networkTimeout=10000\n");
    expect(configureGradleWrapper(configured)).toBe(configured);
  });

  it("adds the checksum when Expo's template has none", () => {
    const configured = configureGradleWrapper("distributionUrl=https\\://example.com/gradle.zip\n");
    expect(configured.match(/^distributionSha256Sum=/gm)).toHaveLength(1);
  });

  it("rejects a template without a distribution URL", () => {
    expect(() => configureGradleWrapper("networkTimeout=10000\n")).toThrow("distribution URL");
  });
});
