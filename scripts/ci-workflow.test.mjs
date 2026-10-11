import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { candidateIdentity } from "../.github/scripts/candidate-identity.mjs";

const repoRoot = new URL("../", import.meta.url);

test("candidate identity binds semver and Android encoding to a clean exact source", () => {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-candidate-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.1.0" }));
    git("add", "package.json");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "test: fixture",
    );
    const sha = git("rev-parse", "HEAD");
    assert.deepEqual(candidateIdentity(sha, undefined, cwd), {
      source_sha: sha,
      fork_version: "0.1.0",
      version_code: 201000,
    });
    assert.throws(() => candidateIdentity(sha, "0.11.2", cwd), /differs from source/);
    assert.throws(() => candidateIdentity("f".repeat(40), "0.1.0", cwd), /differs from checkout/);
    assert.throws(() => candidateIdentity("short", "0.1.0", cwd), /full SHA/);
    writeFileSync(join(cwd, "untracked"), "dirty");
    assert.throws(() => candidateIdentity(sha, "0.1.0", cwd), /must be clean/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("only fork-owned workflows are installed", () => {
  const workflows = readdirSync(new URL(".github/workflows/", repoRoot))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  assert.deepEqual(workflows, [
    "android-arm64-feasibility.yml",
    "candidate-runtime.yml",
    "ci-deep.yml",
    "ci.yml",
    "fork-android-apk.yml",
    "fork-builds.yml",
    "macos-closure.yml",
    "native-feasibility.yml",
    "rebase-dev.yml",
    "upstream-sync.yml",
    "windows-arm64-feasibility.yml",
  ]);
});

test("native candidate runtime is manual, read-only and bounded to hosted Mac verification", () => {
  const source = readFileSync(new URL(".github/workflows/candidate-runtime.yml", repoRoot), "utf8");
  const trigger = source.split("permissions:", 1)[0];
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /push:|pull_request:|schedule:/);
  assert.match(source, /contents: read\s+actions: read/);
  assert.doesNotMatch(source, /: write|secrets\./);
  assert.match(source, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(source, /github\.actor == 'iExalt'/);
  assert.match(source, /runs-on: macos-14/);
  assert.match(source, /timeout-minutes: 30/);
  assert.match(source, /timeout-minutes: 10/);
  assert.match(source, /install_args: node@26\.11\.0/);
  assert.match(source, /cache: false/);
  assert.match(source, /retention-days: 1/);
  assert.match(source, /macos-candidate-runtime\.mjs/);
});

const forkAndroidWorkflowPath = new URL(".github/workflows/fork-android-apk.yml", repoRoot);
const forkBuildsWorkflowPath = new URL(".github/workflows/fork-builds.yml", repoRoot);
const gradleResourceWatchPath = fileURLToPath(
  new URL("scripts/gradle-resource-watch.sh", repoRoot),
);
const runnerSwapPath = fileURLToPath(new URL("scripts/runner-swap.sh", repoRoot));
const filtersPath = new URL(".github/ci-paths.json", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.json"],
    workspace: [
      "mise.toml",
      ".mise/tasks/**",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/scripts/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("fork Android APK workflow is a trusted reusable lane with explicit release identity", () => {
  const source = readFileSync(forkAndroidWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  const jobs = jobBlocks(source.split("jobs:", 2)[1] ?? "");
  const build = jobs.get("build")?.join("\n") ?? "";
  const sign = jobs.get("sign")?.join("\n") ?? "";

  assert.match(trigger, /workflow_call:/);
  assert.match(trigger, /source_sha:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(trigger, /fork_version:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(trigger, /PASEO_FORK_GOOGLE_SERVICES_JSON:[\s\S]*?required: true/);
  assert.match(trigger, /PASEO_FORK_SIGNING_KEY_PKCS8_PEM:[\s\S]*?required: true/);
  assert.match(trigger, /PASEO_FORK_SIGNING_CERT_PEM:[\s\S]*?required: true/);
  assert.doesNotMatch(trigger, /push:|workflow_dispatch:/);
  assert.match(source, /github\.repository == 'iExalt\/paseo'/);
  assert.match(source, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(source, /github\.actor == 'iExalt'/);
  assert.match(build, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(build, /candidate-identity\.mjs "\$SOURCE_SHA" "\$FORK_VERSION"/);
  // Generated WebView output changes a tracked file; bind clean source first.
  assert.ok(
    build.indexOf("Resolve fork Android version code") <
      build.indexOf("Install JavaScript dependencies"),
  );
  assert.ok(
    build.indexOf("Install JavaScript dependencies") <
      build.indexOf("Build terminal WebView assets"),
  );
  assert.doesNotMatch(build, /getForkAndroidVersionCodeFromRunNumber|GITHUB_RUN_NUMBER\)\)/);
  assert.match(build, /PASEO_FORK_GOOGLE_SERVICES_JSON/);
  assert.match(
    build,
    /bash "\$GITHUB_WORKSPACE\/scripts\/gradle-resource-watch\.sh" -- \\\s*\n\s+env JAVA_TOOL_OPTIONS=.*\.\/gradlew :app:assembleRelease \\\s*\n\s+--no-daemon --max-workers=1 -Dorg\.gradle\.parallel=false \\\s*\n\s+-Pkotlin\.compiler\.execution\.strategy=in-process/,
  );
  assert.match(build, /FIREBASE_PROJECT_ID_FORK: paseo-18157/);
  assert.doesNotMatch(build, /PASEO_FORK_SIGNING_(?:KEY|CERT)/);
  assert.match(build, /apkanalyzer="\$ANDROID_HOME\/cmdline-tools\/latest\/bin\/apkanalyzer"/);
  assert.match(build, /Firebase client config failed validation/);
  assert.doesNotMatch(sign, /actions\/checkout|npm |gradlew/);
  assert.match(sign, /apkanalyzer="\$android_home\/cmdline-tools\/latest\/bin\/apkanalyzer"/);
  assert.match(sign, /PASEO_FORK_SIGNING_KEY_PKCS8_PEM/);
  assert.match(sign, /PASEO_FORK_SIGNING_CERT_PEM/);
  assert.match(sign, /permissions:\s*\{\}/);
  assert.match(sign, /sha256sum .*build-metadata\.json/);
  assert.match(sign, /openssl pkcs8 -topk8 -nocrypt .* -outform DER/);
  assert.match(sign, /test "\$signer_count" -eq 1/);
  assert.match(sign, /test "\$VERSION_CODE" -le 2100000000/);
  assert.match(sign, /test "\$\(jq -r \.forkVersion "\$metadata"\)" = "\$FORK_VERSION"/);
  assert.match(sign, /apkSha256/);
  assert.match(sign, /signingRunAttempt/);
  assert.match(sign, /retention-days: 1/);
  assert.match(sign, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact_id \}\}/);
  assert.match(sign, /steps\.upload-final\.outputs\.artifact-digest/);
  assert.match(sign, /verified=true/);

  const buildStepOrder = [
    build.indexOf("name: Generate fork Android project"),
    build.indexOf("name: Assemble arm64 release candidate"),
    build.indexOf("name: Verify and package release candidate"),
    build.indexOf("name: Remove decrypted Firebase client config"),
  ];
  assert.ok(buildStepOrder.every((index) => index >= 0));
  assert.deepEqual(
    buildStepOrder,
    [...buildStepOrder].sort((left, right) => left - right),
  );
  assert.match(build, /name: Remove decrypted Firebase client config\n\s+if: always\(\)/);
});

test("fork candidate orchestration shares one identity and only completes after both verified lanes", () => {
  const source = readFileSync(forkBuildsWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  const jobs = jobBlocks(source.split("jobs:", 2)[1] ?? "");
  const identity = jobs.get("identity")?.join("\n") ?? "";
  const macos = jobs.get("build-macos")?.join("\n") ?? "";
  const android = jobs.get("build-android")?.join("\n") ?? "";
  const candidate = jobs.get("candidate-complete")?.join("\n") ?? "";

  assert.deepEqual(load(source).on, { workflow_dispatch: null });
  assert.doesNotMatch(trigger, /paths:|paths-ignore:/);
  assert.match(source, /github\.repository == 'iExalt\/paseo'/);
  assert.match(source, /github\.actor == 'iExalt'/);
  assert.match(source, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(identity, /candidate-identity\.mjs "\$GITHUB_SHA"/);
  assert.doesNotMatch(identity, /GITHUB_RUN_NUMBER/);
  assert.match(macos, /uses: \.\/\.github\/workflows\/macos-closure\.yml/);
  assert.match(android, /uses: \.\/\.github\/workflows\/fork-android-apk\.yml/);
  assert.match(macos, /source_sha: \$\{\{ needs\.identity\.outputs\.source_sha \}\}/);
  assert.match(android, /fork_version: \$\{\{ needs\.identity\.outputs\.fork_version \}\}/);
  assert.match(candidate, /needs: \[identity, build-macos, build-android\]/);
  assert.match(candidate, /ANDROID_VERIFIED: \$\{\{ needs\.build-android\.outputs\.verified \}\}/);
  assert.match(candidate, /MACOS_VERIFIED: \$\{\{ needs\.build-macos\.outputs\.verified \}\}/);
  assert.match(candidate, /artifact-ids: \$\{\{ needs\.build-android\.outputs\.artifact_id \}\}/);
  assert.match(candidate, /artifact-ids: \$\{\{ needs\.build-macos\.outputs\.artifact_id \}\}/);
  assert.match(candidate, /ANDROID_APK_SHA256/);
  assert.match(candidate, /MACOS_MANIFEST_SHA256/);
  assert.match(candidate, /signingCertificateSha256/);
  assert.match(candidate, /\.signingRunId == \$runId/);
  assert.match(candidate, /\.signingRunAttempt == \$runAttempt/);
  assert.match(candidate, /\.runAttempt \| type == "string"/);
  assert.doesNotMatch(candidate, /\.runAttempt == \$runAttempt/);
  assert.match(candidate, /paired-candidate\.json/);
  assert.doesNotMatch(source, /gh release (?:create|upload)/);

  const macosHelper = readFileSync(
    new URL(".github/scripts/nix-release-closure.sh", repoRoot),
    "utf8",
  );
  assert.match(
    macosHelper,
    /paseo-nix-closure-\$source_sha-\$fork_version-attempt-\$\{GITHUB_RUN_ATTEMPT/,
  );
});

test("candidate metadata rejects old, mixed, wrong-version and wrong-source inventories", () => {
  const source = readFileSync(forkBuildsWorkflowPath, "utf8");
  const start = source.indexOf("          jq -e ");
  const end = source.indexOf("          paired_dir=", start);
  assert.ok(start >= 0 && end > start);
  const script = `set -eu\n${source
    .slice(start, end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")}`;
  const directory = mkdtempSync(join(tmpdir(), "paseo-metadata-"));
  const sha = "a".repeat(40);
  const android = {
    kind: "paseo-verification-candidate",
    schemaVersion: 2,
    platform: "android-arm64",
    sourceSha: sha,
    forkVersion: "0.1.0",
    runId: "1",
    signingRunId: "1",
    runAttempt: "1",
    signingRunAttempt: "1",
    packageId: "sh.paseo.iexalt",
    versionCode: "201000",
    signingCertificateSha256: "c".repeat(64),
    apkSha256: "d".repeat(64),
    abi: "arm64-v8a",
  };
  const macos = {
    kind: "paseo-verification-candidate",
    schemaVersion: 2,
    platform: "macos-arm64",
    sourceSha: sha,
    forkVersion: "0.1.0",
    lockHash: "b".repeat(64),
    system: "aarch64-darwin",
    outputPath: "/nix/store/test",
    provenance: "local-ci-build",
    nodeSeed: { provenance: "local-built-dependency" },
    closure: [{ path: "/nix/store/test" }],
  };
  try {
    for (const [lane, delta, accepted] of [
      ["android", {}, true],
      ...["android", "macos"].flatMap((target) => [
        [target, { kind: "published-release" }, false],
        [target, { schemaVersion: 1 }, false],
        [target, { releaseSequence: 200001 }, false],
        [target, { forkVersion: "0.2.0" }, false],
        [target, { sourceSha: "f".repeat(40) }, false],
        [target, { platform: "windows-arm64" }, false],
      ]),
      ["android", { apkSha256: "e".repeat(64) }, false],
    ]) {
      writeFileSync(
        join(directory, "android.json"),
        JSON.stringify({ ...android, ...(lane === "android" ? delta : {}) }),
      );
      writeFileSync(
        join(directory, "macos.json"),
        JSON.stringify({ ...macos, ...(lane === "macos" ? delta : {}) }),
      );
      const result = spawnSync("/bin/bash", ["-c", script], {
        env: {
          PATH: process.env.PATH,
          SOURCE_SHA: sha,
          FORK_VERSION: "0.1.0",
          GITHUB_RUN_ID: "1",
          android_artifact_attempt: "1",
          ANDROID_PACKAGE_ID: android.packageId,
          ANDROID_VERSION_CODE: android.versionCode,
          APPROVED_ANDROID_CERT_SHA256: android.signingCertificateSha256,
          ANDROID_APK_SHA256: android.apkSha256,
          MACOS_LOCK_HASH: macos.lockHash,
          MACOS_OUTPUT_PATH: macos.outputPath,
          android_metadata: join(directory, "android.json"),
          macos_manifest: join(directory, "macos.json"),
        },
      });
      assert.equal(
        result.status === 0,
        accepted,
        `${lane} ${JSON.stringify(delta)}: ${result.stderr}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paired candidate retries retain successful lane attempts without accepting future artifacts", () => {
  const source = readFileSync(forkBuildsWorkflowPath, "utf8");
  const start = source.indexOf("          android_artifact_attempt=");
  const end = source.indexOf("          android_dir=", start);
  assert.ok(start >= 0 && end > start);
  const validation = `set -euo pipefail\n${source
    .slice(start, end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")}`;
  const sha = "a".repeat(40);
  for (const [androidAttempt, macosAttempt, accepted] of [
    ["1", "2", true],
    ["2", "1", true],
    ["3", "2", false],
    ["1", "3", false],
    ["0", "2", false],
  ]) {
    const result = spawnSync("/bin/bash", ["-c", validation], {
      env: {
        SOURCE_SHA: sha,
        FORK_VERSION: "0.1.0",
        ANDROID_VERSION_CODE: "200001",
        GITHUB_RUN_ATTEMPT: "2",
        ANDROID_ARTIFACT_NAME: `paseo-iexalt-200001-${sha}-attempt-${androidAttempt}`,
        MACOS_ARTIFACT_NAME: `paseo-nix-closure-${sha}-0.1.0-attempt-${macosAttempt}`,
      },
    });
    assert.equal(result.status === 0, accepted, `${androidAttempt}/${macosAttempt}`);
  }
});

test("fork Android resource watcher is paired and preserves child exit and signal status", async () => {
  const source = readFileSync(gradleResourceWatchPath, "utf8");
  assert.match(source, /interval_seconds=60/);
  assert.match(source, /free -b/);
  assert.match(source, /swap_total_bytes=%s swap_used_bytes=%s swap_free_bytes=%s/);
  assert.match(source, /df -Pk/);
  assert.match(source, /\/sys\/fs\/cgroup\/memory\.events/);
  assert.match(source, /oom_group_kill/);
  assert.match(source, /ps -Ao rss=,%cpu=,comm=/);
  assert.doesNotMatch(source, /ps[^\n]*(?:args|command=|cmdline)/);

  for (const [exitCode, expectedStatus] of [
    [0, 0],
    [23, 23],
  ]) {
    const result = spawnSync(
      "bash",
      [gradleResourceWatchPath, "--", "bash", "-c", `exit ${exitCode}`],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, expectedStatus);
    assert.match(result.stdout, /gradle_heartbeat_utc=/);
    assert.match(result.stdout, new RegExp(`gradle_child_exit_code=${expectedStatus}`));
    assert.match(result.stdout, new RegExp(`gradle_wrapper_exit_code=${expectedStatus}`));
    assert.match(result.stdout, /gradle_heartbeat_sampler_exit_code=0/);
  }

  const signalCases = [
    {
      signal: "SIGTERM",
      name: "TERM",
      nodeSignal: "SIGTERM",
      childHandler: true,
      childStatus: 37,
      wrapperStatus: 37,
    },
    {
      signal: "SIGINT",
      name: "INT",
      nodeSignal: "SIGINT",
      childHandler: true,
      childStatus: 38,
      wrapperStatus: 38,
    },
    {
      signal: "SIGTERM",
      name: "TERM",
      nodeSignal: "SIGTERM",
      childHandler: false,
      wrapperStatus: 143,
    },
  ];
  for (const signalCase of signalCases) {
    const childCode = [
      signalCase.childHandler
        ? `process.on("${signalCase.nodeSignal}", () => process.exit(${signalCase.childStatus}));`
        : "",
      'process.stdout.write("fake_child_ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const child = spawn(
      "bash",
      [gradleResourceWatchPath, "--interval-seconds", "1", "--", "node", "-e", childCode],
      { detached: true, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let signalSent = false;
    child.stdout.setEncoding("utf8");
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        reject(new Error(`resource watcher did not exit after ${signalCase.name}`));
      }, 5000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!signalSent && output.includes("fake_child_ready")) {
          signalSent = true;
          child.kill(signalCase.signal);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(result, { code: signalCase.wrapperStatus, signal: null });
    assert.match(output, new RegExp(`gradle_wrapper_signal=${signalCase.name}`));
    assert.match(output, new RegExp(`gradle_child_exit_code=${signalCase.wrapperStatus}`));
    assert.match(output, /gradle_heartbeat_sampler_exit_code=0/);
    assert.match(output, new RegExp(`gradle_wrapper_exit_code=${signalCase.wrapperStatus}`));
  }
});

test("fork Android swap is provisioned after SDK setup and always cleaned before packaging", () => {
  const source = readFileSync(forkAndroidWorkflowPath, "utf8");
  const sdkSetup = source.indexOf("- name: Install pinned Android SDK packages");
  const swapSetup = source.indexOf('bash "$GITHUB_WORKSPACE/scripts/runner-swap.sh" enable');
  const assemble = source.indexOf("- name: Assemble arm64 release candidate");
  const swapCleanup = source.indexOf("- name: Disable and remove task-owned Android swap");
  const verify = source.indexOf("- name: Verify and package release candidate");

  assert.match(source, /timeout-minutes: 60/);
  assert.ok(sdkSetup >= 0 && sdkSetup < swapSetup);
  assert.ok(swapSetup < assemble && assemble < swapCleanup && swapCleanup < verify);
  assert.match(
    source.slice(swapCleanup, verify),
    /if: always\(\)[\s\S]*?timeout-minutes: 3[\s\S]*?runner-swap\.sh" cleanup/,
  );
});

test("fork Android swap lifecycle is bounded and never unlinks active swap", () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "paseo-runner-swap-"));
  const fakeBin = join(fixtureDirectory, "bin");
  const activeSwapFile = join(fixtureDirectory, "active-swap");
  const dfCountFile = join(fixtureDirectory, "df-count");
  const runnerTemp = join(fixtureDirectory, "runner-temp");
  const swapFile = join(runnerTemp, "paseo-fork-gradle.swap");
  const ownerDirectory = join(runnerTemp, "paseo-fork-gradle-swap-owner");
  mkdirSync(fakeBin);
  mkdirSync(runnerTemp);

  const fakeCommands = {
    df: `#!/bin/sh
count=0
if [ -f "$DF_COUNT_FILE" ]; then read -r count < "$DF_COUNT_FILE"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$DF_COUNT_FILE"
if [ "$count" -eq 1 ]; then available="$DF_BEFORE_KB"; else available="$DF_AFTER_KB"; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 100000000 1 %s 1%% %s\\n' "$available" "$1"
`,
    fallocate: `#!/bin/sh
test "$1" = -l
truncate -s "$2" "$3"
`,
    sudo: `#!/bin/sh
case "$1" in
  mkswap) exit 0 ;;
  swapon) printf '%s\\n' "$2" > "$ACTIVE_SWAP_FILE" ;;
  swapoff)
    if [ "$FAIL_SWAPOFF" = 1 ]; then exit 1; fi
    : > "$ACTIVE_SWAP_FILE"
    ;;
  *) exit 2 ;;
esac
`,
    swapon: `#!/bin/sh
if [ "$FAIL_SWAPON_QUERY" = 1 ]; then exit 1; fi
if [ -f "$ACTIVE_SWAP_FILE" ]; then cat "$ACTIVE_SWAP_FILE"; fi
`,
  };
  for (const [name, source] of Object.entries(fakeCommands)) {
    const file = join(fakeBin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o700);
  }

  const baseEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    GITHUB_REPOSITORY: "iExalt/paseo",
    GITHUB_REF: "refs/heads/dev",
    GITHUB_ACTOR: "iExalt",
    RUNNER_TEMP: runnerTemp,
    ACTIVE_SWAP_FILE: activeSwapFile,
    DF_COUNT_FILE: dfCountFile,
    DF_BEFORE_KB: String(24 * 1024 * 1024),
    DF_AFTER_KB: String(8 * 1024 * 1024 - 1),
    FAIL_SWAPOFF: "0",
    FAIL_SWAPON_QUERY: "0",
  };

  try {
    const untrustedContext = spawnSync("bash", [runnerSwapPath, "enable"], {
      encoding: "utf8",
      env: { ...baseEnvironment, GITHUB_ACTOR: "other-user" },
      timeout: 5000,
    });
    assert.equal(untrustedContext.status, 1);
    assert.equal(existsSync(ownerDirectory), false);
    assert.equal(existsSync(swapFile), false);

    writeFileSync(swapFile, "pre-existing runner file");
    const existingPath = spawnSync("bash", [runnerSwapPath, "enable"], {
      encoding: "utf8",
      env: baseEnvironment,
      timeout: 5000,
    });
    assert.equal(existingPath.status, 1);
    assert.equal(readFileSync(swapFile, "utf8"), "pre-existing runner file");
    const unownedCleanup = spawnSync("bash", [runnerSwapPath, "cleanup"], {
      encoding: "utf8",
      env: baseEnvironment,
      timeout: 5000,
    });
    assert.equal(unownedCleanup.status, 0);
    assert.equal(readFileSync(swapFile, "utf8"), "pre-existing runner file");
    rmSync(swapFile);

    const lowSpace = spawnSync("bash", [runnerSwapPath, "enable"], {
      encoding: "utf8",
      env: { ...baseEnvironment, DF_BEFORE_KB: String(24 * 1024 * 1024 - 1) },
      timeout: 5000,
    });
    assert.equal(lowSpace.status, 1);
    assert.equal(existsSync(ownerDirectory), false);
    assert.equal(existsSync(swapFile), false);

    writeFileSync(dfCountFile, "0");
    const insufficientHeadroom = spawnSync("bash", [runnerSwapPath, "enable"], {
      encoding: "utf8",
      env: baseEnvironment,
      timeout: 5000,
    });
    assert.equal(insufficientHeadroom.status, 1);
    assert.equal(existsSync(ownerDirectory), false);
    assert.equal(existsSync(swapFile), false);
    assert.equal(readFileSync(activeSwapFile, "utf8"), "");

    writeFileSync(dfCountFile, "0");
    const enabled = spawnSync("bash", [runnerSwapPath, "enable"], {
      encoding: "utf8",
      env: { ...baseEnvironment, DF_AFTER_KB: String(8 * 1024 * 1024) },
      timeout: 5000,
    });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(statSync(swapFile).size, 16 * 1024 * 1024 * 1024);
    assert.equal(statSync(swapFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(activeSwapFile, "utf8").trim(), swapFile);

    const unverified = spawnSync("bash", [runnerSwapPath, "cleanup"], {
      encoding: "utf8",
      env: { ...baseEnvironment, FAIL_SWAPON_QUERY: "1" },
      timeout: 5000,
    });
    assert.equal(unverified.status, 1);
    assert.equal(existsSync(swapFile), true);
    assert.equal(readFileSync(activeSwapFile, "utf8").trim(), swapFile);

    const retained = spawnSync("bash", [runnerSwapPath, "cleanup"], {
      encoding: "utf8",
      env: { ...baseEnvironment, FAIL_SWAPOFF: "1" },
      timeout: 5000,
    });
    assert.equal(retained.status, 1);
    assert.equal(existsSync(swapFile), true);
    assert.equal(readFileSync(activeSwapFile, "utf8").trim(), swapFile);

    const cleaned = spawnSync("bash", [runnerSwapPath, "cleanup"], {
      encoding: "utf8",
      env: baseEnvironment,
      timeout: 5000,
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(swapFile), false);
    assert.equal(existsSync(ownerDirectory), false);
    assert.equal(readFileSync(activeSwapFile, "utf8"), "");
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
