import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const { mkdtemp, rm, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "paseo-ios-config-"));
  try {
    await symlink(join(__dirname, "assets"), join(root, "assets"), "dir");
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

const { getConfig } = requireFromExpoCli("@expo/config");
const { AndroidConfig } = requireFromExpo("expo/config-plugins");
const { withForkBuild } = require("./plugins/with-fork-build");

const forkFirebaseConfig = {
  project_info: { project_id: "fork-fixture" },
  client: [{ client_info: { android_client_info: { package_name: "sh.paseo.iexalt" } } }],
};

describe("fork build platform boundary", () => {
  beforeEach(() => {
    // Expo caches static app.config exports; re-evaluate for each environment fixture.
    delete require.cache[require.resolve("./app.config.js")];
    vi.stubEnv("APP_VARIANT", "fork");
    vi.stubEnv("EAS_BUILD_PLATFORM", undefined);
    vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", undefined);
    vi.stubEnv("FIREBASE_PROJECT_ID_FORK", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete require.cache[require.resolve("./app.config.js")];
  });

  it.each([undefined, "/missing/android-firebase.json"])(
    "rejects an EAS iOS fork build before reading Android credentials (%s)",
    (androidFile) => {
      vi.stubEnv("EAS_BUILD_PLATFORM", "ios");
      vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", androidFile);
      expect(() => getConfig(__dirname)).toThrow("Fork iOS builds are not supported");
    },
  );

  it.each([undefined, "/missing/android-firebase.json"])(
    "rejects local iOS mods without demanding Android credentials (%s)",
    async (androidFile) => {
      vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", androidFile);
      const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
      await expect(
        compileModsAsync(exp, {
          projectRoot: __dirname,
          introspect: true,
          platforms: ["ios"],
          assertMissingModProviders: false,
        }),
      ).rejects.toThrow("Fork iOS builds are not supported");
    },
    30_000,
  );

  it("rejects the maintained iOS release command before building dependencies or opening Expo", async () => {
    const { spawnSync } = await import("node:child_process");
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
      throw new Error("Run the config tests through npm or npx to provide npm_execpath.");
    }
    const result = spawnSync(process.execPath, [npmCli, "run", "ios:release", "--silent"], {
      cwd: __dirname,
      env: { ...process.env, APP_VARIANT: "fork" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Fork iOS builds are not supported");
    expect(output).not.toContain("build:client");
    expect(output).not.toContain("expo run:ios");
  });

  it("does not advertise an iOS identity or require credentials for generic fork config", () => {
    const { exp } = getConfig(__dirname);
    expect(exp.platforms).toEqual(["android"]);
    expect(exp.ios?.bundleIdentifier).toBeUndefined();
    expect(exp.android.package).toBe("sh.paseo.iexalt");
    expect(exp.extra.forkUpdatesEnabled).toBe(true);
  });

  it.each([
    ["production", "sh.paseo", "GOOGLE_SERVICE_INFO_PLIST_PROD"],
    ["development", "sh.paseo.debug", "GOOGLE_SERVICE_INFO_PLIST_DEBUG"],
  ])("preserves %s iOS identity and plist configuration", (variant, identifier, plistEnv) => {
    vi.stubEnv("APP_VARIANT", variant);
    vi.stubEnv("EAS_BUILD_PLATFORM", "ios");
    vi.stubEnv(plistEnv, "/fixture/GoogleService-Info.plist");
    const { exp } = getConfig(__dirname);
    expect(exp.ios.bundleIdentifier).toBe(identifier);
    expect(exp.ios.googleServicesFile).toBe("/fixture/GoogleService-Info.plist");
  });

  it.each([
    [undefined, undefined, undefined, "absolute decrypted JSON path"],
    ["relative.json", "fork-fixture", undefined, "absolute decrypted JSON path"],
    ["/missing/fork-firebase.json", "fork-fixture", undefined, "readable Firebase Android JSON"],
    ["fixture", undefined, "{}", "FIREBASE_PROJECT_ID_FORK"],
    ["fixture", "fork-fixture", "not-json", "readable Firebase Android JSON"],
    ["fixture", "wrong-project", JSON.stringify(forkFirebaseConfig), "expected project"],
    [
      "fixture",
      "fork-fixture",
      JSON.stringify({ ...forkFirebaseConfig, client: [] }),
      "sh.paseo.iexalt",
    ],
  ])(
    "rejects invalid fork Android credentials at Android generation (%s, %s)",
    async (androidFile, projectId, contents, message) => {
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const root = await mkdtemp(join(tmpdir(), "paseo-fork-config-"));
      try {
        const file = join(root, "google-services.json");
        if (contents !== undefined) await writeFile(file, contents);
        vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", androidFile === "fixture" ? file : androidFile);
        vi.stubEnv("FIREBASE_PROJECT_ID_FORK", projectId);
        await expect(resolveAndroidManifest()).rejects.toThrow(message);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("validates the exact configured Android file that Expo copies during ordinary mods", async () => {
    const { mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "paseo-fork-android-mods-"));
    try {
      const file = join(root, "fork-firebase.json");
      const manifestDir = join(root, "android/app/src/main");
      const manifestFile = join(manifestDir, "AndroidManifest.xml");
      await mkdir(manifestDir, { recursive: true });
      await writeFile(file, JSON.stringify(forkFirebaseConfig));
      await writeFile(
        manifestFile,
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="sh.paseo.iexalt"><application /></manifest>',
      );
      vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", file);
      vi.stubEnv("FIREBASE_PROJECT_ID_FORK", "fork-fixture");
      const { exp } = getConfig(__dirname, { skipPlugins: true });
      vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", "/missing/unused-environment-file.json");
      // Isolate the shipped fork guard and Expo's real file-copy mod from unrelated native plugins.
      const config = AndroidConfig.GoogleServices.withGoogleServicesFile(withForkBuild(exp));
      await compileModsAsync(config, {
        projectRoot: root,
        platforms: ["android"],
      });
      expect(
        JSON.parse(await readFile(join(root, "android/app/google-services.json"), "utf8")),
      ).toEqual(forkFirebaseConfig);
      expect(await readFile(manifestFile, "utf8")).toContain("sh.paseo.iexalt");

      const invalidFile = join(root, "invalid-firebase.json");
      await writeFile(invalidFile, JSON.stringify({ ...forkFirebaseConfig, client: [] }));
      vi.stubEnv("GOOGLE_SERVICES_FILE_FORK", file);
      const next = AndroidConfig.GoogleServices.withGoogleServicesFile(
        withForkBuild({
          ...exp,
          android: { ...exp.android, googleServicesFile: invalidFile },
          mods: {},
        }),
      );
      await expect(
        compileModsAsync(next, { projectRoot: root, platforms: ["android"] }),
      ).rejects.toThrow("sh.paseo.iexalt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
