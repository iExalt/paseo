import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

const repoRoot = new URL("../", import.meta.url);

test("only fork-owned workflows are installed", () => {
  const workflows = readdirSync(new URL(".github/workflows/", repoRoot))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  assert.deepEqual(workflows, [
    "ci-deep.yml",
    "ci.yml",
    "rebase-dev.yml",
    "release-please.yml",
    "release.yml",
    "upstream-sync.yml",
  ]);
});

test("release keeps each secret in its job and publishes only release tags", () => {
  const workflow = load(readFileSync(new URL(".github/workflows/release.yml", repoRoot), "utf8"));
  const secrets = Object.fromEntries(
    Object.entries(workflow.jobs).map(([name, job]) => [
      name,
      [...JSON.stringify(job).matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort(),
    ]),
  );
  assert.deepEqual(secrets, {
    resolve: [],
    "macos-build": ["PASEO_NIX_RELEASE_SIGNING_KEY"],
    "macos-smoke": [],
    "android-build": ["PASEO_FORK_GOOGLE_SERVICES_JSON"],
    "android-sign": ["PASEO_FORK_SIGNING_CERT_PEM", "PASEO_FORK_SIGNING_KEY_PKCS8_PEM"],
    publish: ["PASEO_RELEASE_MANIFEST_PRIVATE_KEY"],
  });
  assert.deepEqual(workflow.permissions, {});
  for (const [name, job] of Object.entries(workflow.jobs))
    assert.equal(job.permissions.contents, name === "publish" ? "write" : "read", name);
  // Dispatch only, so the caches it saves land on dev, where the next release
  // can read them; a tag run's caches are invisible to every other tag.
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.match(workflow.jobs.resolve.if, /github\.ref == 'refs\/heads\/dev'/);
  const releasePlease = load(
    readFileSync(new URL(".github/workflows/release-please.yml", repoRoot), "utf8"),
  );
  assert.match(
    releasePlease.jobs.dispatch.steps.at(-1).run,
    /gh workflow run release\.yml .*--ref dev -f tag="\$TAG"/,
  );
  // A dispatch without a tag uploads a draft under a paseo-dryrun- tag and never
  // reaches publication; a tag must name the version it points at.
  const publishing = workflow.jobs.publish.steps.filter((step) =>
    step.run?.includes("release-publish.sh publish"),
  );
  assert.deepEqual(
    publishing.map((step) => step.if),
    ["needs.resolve.outputs.publish == 'true'"],
  );
  assert.match(
    workflow.jobs.resolve.steps.at(-1).run,
    /if \[\[ -n "\$TAG" \]\]; then\s+publish=true\s+if \[\[ "\$TAG" != "paseo-v\$version" \]\][\s\S]*else\s+publish=false\s+tag="paseo-dryrun-\$GITHUB_RUN_ID"/,
  );
});

const gradleResourceWatchPath = fileURLToPath(
  new URL("scripts/gradle-resource-watch.sh", repoRoot),
);
const runnerSwapPath = fileURLToPath(new URL("scripts/runner-swap.sh", repoRoot));
const filtersPath = new URL(".github/ci-paths.json", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

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
      {
        detached: true,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
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

test("release Android swap is provisioned after SDK setup and always cleaned before identity checks", () => {
  const steps = load(readFileSync(new URL(".github/workflows/release.yml", repoRoot), "utf8")).jobs[
    "android-build"
  ].steps;
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run ?? ""));
  const enable = index(/sdkmanager[\s\S]*runner-swap\.sh enable/);
  const assemble = index(/gradlew :app:assembleRelease/);
  const cleanup = index(/runner-swap\.sh cleanup/);
  const identity = index(/release-apk-identity\.sh/);
  assert.ok(enable >= 0 && enable < assemble && assemble < cleanup && cleanup < identity);
  assert.equal(steps[cleanup].if, "always()");
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

    // release-please.yml dispatches the release on dev as github-actions[bot].
    const cleanupAs = (environment) =>
      spawnSync("bash", [runnerSwapPath, "cleanup"], {
        encoding: "utf8",
        env: { ...baseEnvironment, GITHUB_ACTOR: "github-actions[bot]", ...environment },
        timeout: 5000,
      }).status;
    assert.equal(cleanupAs({}), 0);
    assert.equal(cleanupAs({ GITHUB_REF: "refs/tags/paseo-v0.6.0" }), 1);
    assert.equal(cleanupAs({ GITHUB_ACTOR: "paseo-release[bot]" }), 1);

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
