import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const forkAndroidWorkflowPath = new URL(".github/workflows/fork-android-apk.yml", repoRoot);
const forkBuildsWorkflowPath = new URL(".github/workflows/fork-builds.yml", repoRoot);
const gradleResourceWatchPath = fileURLToPath(
  new URL("scripts/gradle-resource-watch.sh", repoRoot),
);
const deployWebsiteWorkflowPath = new URL(".github/workflows/deploy-website.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  ["server-tests-macos", { name: "server-tests (macos-14, file observation)", contract: "server" }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

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
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
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

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
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

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+branches: \[main\]\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("fork Android APK workflow is a trusted reusable lane with explicit release identity", () => {
  const source = readFileSync(forkAndroidWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  const jobs = jobBlocks(source.split("jobs:", 2)[1] ?? "");
  const build = jobs.get("build")?.join("\n") ?? "";
  const sign = jobs.get("sign")?.join("\n") ?? "";

  assert.match(trigger, /workflow_call:/);
  assert.match(trigger, /source_sha:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(trigger, /release_sequence:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(trigger, /PASEO_FORK_GOOGLE_SERVICES_JSON:[\s\S]*?required: true/);
  assert.match(trigger, /PASEO_FORK_SIGNING_KEY_PKCS8_PEM:[\s\S]*?required: true/);
  assert.match(trigger, /PASEO_FORK_SIGNING_CERT_PEM:[\s\S]*?required: true/);
  assert.doesNotMatch(trigger, /push:|workflow_dispatch:/);
  assert.match(source, /github\.repository == 'iExalt\/paseo'/);
  assert.match(source, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(source, /github\.actor == 'iExalt'/);
  assert.match(build, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(build, /getRequiredAndroidVersionCode\(process\.env\.RELEASE_SEQUENCE\)/);
  assert.doesNotMatch(build, /getForkAndroidVersionCodeFromRunNumber|GITHUB_RUN_NUMBER\)\)/);
  assert.match(build, /PASEO_FORK_GOOGLE_SERVICES_JSON/);
  assert.match(
    build,
    /bash "\$GITHUB_WORKSPACE\/scripts\/gradle-resource-watch\.sh" -- \\\s*\n\s+env JAVA_TOOL_OPTIONS=.*\.\/gradlew :app:assembleRelease \\\s*\n\s+--no-daemon --max-workers=2 -Dorg\.gradle\.parallel=false/,
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
  assert.match(sign, /test "\$\(jq -r \.releaseSequence "\$metadata"\)" = "\$RELEASE_SEQUENCE"/);
  assert.match(sign, /apkSha256/);
  assert.match(sign, /signingRunAttempt/);
  assert.match(sign, /retention-days: 7/);
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

  assert.match(trigger, /push:[\s\S]*?branches: \[dev\]/);
  assert.match(
    trigger,
    /paths:[\s\S]*?flake\.lock[\s\S]*?nix\/\*\*[\s\S]*?packages\/desktop\/\*\*/,
  );
  assert.doesNotMatch(trigger, /paths-ignore:|docs\/\*\*/);
  assert.doesNotMatch(trigger, /pull_request:|workflow_dispatch:/);
  assert.match(source, /github\.repository == 'iExalt\/paseo'/);
  assert.match(source, /github\.actor == 'iExalt'/);
  assert.match(identity, /release_sequence=\$\(\(200000 \+ GITHUB_RUN_NUMBER\)\)/);
  assert.match(identity, /source_sha=\$GITHUB_SHA/);
  assert.match(macos, /uses: \.\/\.github\/workflows\/macos-closure\.yml/);
  assert.match(android, /uses: \.\/\.github\/workflows\/fork-android-apk\.yml/);
  assert.match(macos, /source_sha: \$\{\{ needs\.identity\.outputs\.source_sha \}\}/);
  assert.match(android, /release_sequence: \$\{\{ needs\.identity\.outputs\.release_sequence \}\}/);
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
  assert.doesNotMatch(source, /gh release (?:create|upload)|workflow_dispatch/);

  const macosHelper = readFileSync(
    new URL(".github/scripts/nix-release-closure.sh", repoRoot),
    "utf8",
  );
  assert.match(
    macosHelper,
    /paseo-nix-closure-\$source_sha-\$release_sequence-attempt-\$\{GITHUB_RUN_ATTEMPT/,
  );
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
        RELEASE_SEQUENCE: "200001",
        ANDROID_VERSION_CODE: "200001",
        GITHUB_RUN_ATTEMPT: "2",
        ANDROID_ARTIFACT_NAME: `paseo-iexalt-200001-${sha}-attempt-${androidAttempt}`,
        MACOS_ARTIFACT_NAME: `paseo-nix-closure-${sha}-200001-attempt-${macosAttempt}`,
      },
    });
    assert.equal(result.status === 0, accepted, `${androidAttempt}/${macosAttempt}`);
  }
});

test("fork release publication cannot trigger the upstream website deployment", () => {
  const source = readFileSync(deployWebsiteWorkflowPath, "utf8");
  assert.match(source, /release:\s*\n\s+types:\s*\[published\]/);
  assert.match(source, /if:\s*\$\{\{\s*github\.repository == 'getpaseo\/paseo'/);
  assert.match(
    source,
    /github\.event_name != 'release'\s*\|\|\s*\(!github\.event\.release\.prerelease && !github\.event\.release\.draft\)/,
  );
});

test("fork Android resource watcher is paired and preserves child exit and signal status", async () => {
  const source = readFileSync(gradleResourceWatchPath, "utf8");
  const pairedWorkflow = readFileSync(forkBuildsWorkflowPath, "utf8");
  assert.match(source, /interval_seconds=60/);
  assert.match(source, /free -b/);
  assert.match(source, /df -Pk/);
  assert.match(source, /\/sys\/fs\/cgroup\/memory\.events/);
  assert.match(source, /oom_group_kill/);
  assert.match(source, /ps -Ao rss=,%cpu=,comm=/);
  assert.doesNotMatch(source, /ps[^\n]*(?:args|command=|cmdline)/);
  assert.match(pairedWorkflow, /"scripts\/gradle-resource-watch\.sh"/);

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
