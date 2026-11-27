import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, machine, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeepCleanup } from "./deep-cleanup.mjs";
import { dependencyFingerprint } from "./dependency-fingerprint.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));

const METRO_CONFIG_FILES = [
  "packages/app/babel.config.js",
  "packages/app/metro.config.cjs",
  "packages/app/tsconfig.json",
];

const digest = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
};

export async function deepCacheKeys(cwd = root, env = process.env) {
  const { modules } = await dependencyFingerprint(cwd, env);
  const lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
  const playwrightVersion = lock.packages?.["node_modules/playwright-core"]?.version;
  assert.ok(playwrightVersion, "package-lock.json must pin playwright-core");
  const metroConfigParts = METRO_CONFIG_FILES.map(
    (file) => `${file}\n${readFileSync(resolve(cwd, file), "utf8")}`,
  );
  const metroConfigDigest = digest(...metroConfigParts).slice(0, 16);
  const platformKey = `${env.ImageOS}-${machine()}`;
  const metroPrefix = `deep-metro-v1-${platformKey}-`;
  return {
    playwright_key: `deep-playwright-v1-${platformKey}-pw${playwrightVersion}`,
    playwright_path: env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright"),
    metro_prefix: metroPrefix,
    metro_key: `${metroPrefix}node${process.version}-${modules.slice(0, 24)}-${metroConfigDigest}`,
    metro_path: join(tmpdir(), "metro-cache"),
  };
}

export function parsePlaywrightInstallLocations(output) {
  const locations = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*Install location:\s+(.+?)\s*$/);
    if (match) locations.push(match[1]);
  }
  return locations;
}

function findFileRecursive(dir, filename, maxDepth = 3) {
  if (maxDepth < 0 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return full;
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

export function ensurePlaywrightChromium({
  cwd = root,
  platform = process.platform,
  run = spawnSync,
  exists = existsSync,
  findBinary = (dir) => findFileRecursive(dir, "chrome-headless-shell", 2),
} = {}) {
  const dryRun = run(
    "npm",
    [
      "exec",
      "--workspace=@getpaseo/app",
      "--",
      "playwright",
      "install",
      "--dry-run",
      "--only-shell",
      "chromium",
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const locations = dryRun.status === 0 ? parsePlaywrightInstallLocations(dryRun.stdout) : [];
  const allInstalled =
    locations.length > 0 &&
    locations.every((dir) => exists(dir) && exists(join(dir, "INSTALLATION_COMPLETE")));
  const shellDir = locations.find((dir) => dir.includes("chromium_headless_shell"));
  const shellBin = allInstalled && shellDir ? findBinary(shellDir) : null;

  let libsReady = Boolean(shellBin);
  if (libsReady && platform === "linux") {
    const ldd = run("ldd", [shellBin], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lddOutput = `${ldd.stdout ?? ""}\n${ldd.stderr ?? ""}`;
    libsReady = ldd.status === 0 && !/not found/i.test(lddOutput);
  }

  if (allInstalled && libsReady) {
    console.log(
      "[deep] Playwright Chromium headless shell already installed with all shared libraries; skipping install",
    );
    return { skipped: true, status: 0 };
  }

  const install = run(
    "npm",
    [
      "exec",
      "--workspace=@getpaseo/app",
      "--",
      "playwright",
      "install",
      "--with-deps",
      "--only-shell",
      "chromium",
    ],
    { cwd, stdio: "inherit" },
  );
  if (install.error) throw install.error;
  assert.equal(install.status, 0, "Playwright Chromium headless shell install failed");
  return { skipped: false, status: 0 };
}

export function validateDeepSource(sha, cwd = root, env = process.env) {
  assert.match(sha, /^[a-f0-9]{40}$/, "Deep source must be a full captured SHA");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  assert.equal(head, sha, "Deep checkout must match the captured source");
  for (const key of Object.keys(env)) {
    assert.ok(
      !key.startsWith("E2E_") && !key.startsWith("PASEO_REPLICA_CACHE_MEASUREMENT"),
      `Deep verification rejects environment override ${key}`,
    );
  }
  assert.ok(!existsSync(resolve(cwd, ".env.test")), "Deep verification rejects .env.test");
}

export function deepCommands(lane) {
  if (lane === "integration") {
    return [
      ["npm", ["run", "build:server"]],
      [
        "node",
        [
          "--import",
          "tsx",
          "packages/cli/tests/23-daemon-sigint-supervisor.test.ts",
          "--dev-watch",
        ],
      ],
      [
        "npm",
        [
          "exec",
          "--",
          "vitest",
          "run",
          "packages/cli/src/commands/daemon/lifecycle.e2e.test.ts",
          "--maxWorkers=1",
          "--maxConcurrency=3",
        ],
      ],
      [
        "env",
        [
          "FORCE_RELAY_E2E=1",
          "npm",
          "exec",
          "--",
          "vitest",
          "run",
          "packages/relay/src/e2e.test.ts",
          "--maxWorkers=1",
        ],
      ],
      [
        "npm",
        [
          "exec",
          "--workspace=@getpaseo/server",
          "--",
          "vitest",
          "run",
          "--maxWorkers=1",
          "src/server/agent/providers/opencode-bridge.local.e2e.test.ts",
          "-t",
          "versioned runtime",
        ],
      ],
      ["npm", ["ci", "--prefix", ".github/deep-providers", "--no-audit", "--no-fund"]],
      ["node", [".github/scripts/check-provider-versions.mjs"]],
    ];
  }
  if (lane === "electron") {
    return [
      ["npm", ["run", "build:server"]],
      ["npm", ["run", "build:main", "--workspace=@getpaseo/desktop"]],
      ["npm", ["exec", "--workspace=@getpaseo/desktop", "--", "install-electron"]],
      ["sudo", ["apt-get", "update", "-qq"]],
      // List every library Electron links so the lane also runs on hosts without the runner
      // image's desktop stack; --no-upgrade leaves packages the image already has untouched.
      [
        "sudo",
        [
          "apt-get",
          "install",
          "-y",
          "--no-upgrade",
          "xvfb",
          "xdotool",
          "libnss3",
          "libatk-bridge2.0-0",
          "libcups2",
          "libgbm1",
          "libasound2t64",
          "libgtk-3-0t64",
          "libcairo2",
          "libpango-1.0-0",
          "libxcomposite1",
          "libxdamage1",
          "libxfixes3",
        ],
      ],
      [
        "env",
        [
          "PASEO_DESKTOP_LIFECYCLE_ARTIFACT_DIR=" +
            resolve(root, ".dev/github-workflows/deep/electron"),
          "xvfb-run",
          "-a",
          "node",
          "packages/desktop/e2e/daemon-lifecycle.e2e.mjs",
        ],
      ],
    ];
  }
  assert.equal(lane, "browser", "Unknown deep lane");
  return [
    ["npm", ["run", "build:server"]],
    ["node", [".github/scripts/ci-deep.mjs", "--ensure-playwright-chromium"]],
    [
      "npm",
      [
        "exec",
        "--workspace=@getpaseo/app",
        "--",
        "playwright",
        "test",
        "--config=playwright.deep.config.ts",
      ],
    ],
  ];
}

export function runDeep(commands, run = spawnSync, checkCleanup = verifyDeepCleanup) {
  for (const [command, args] of commands) {
    const owner = randomUUID();
    const started = performance.now();
    let result;
    try {
      result = run(command, args, {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, CI_DEEP_OWNER: owner },
      });
    } finally {
      checkCleanup(owner);
    }
    console.log(
      `[deep] ${command} ${args.join(" ")}: ${((performance.now() - started) / 1000).toFixed(2)}s`,
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Deep command failed: ${command} ${args.join(" ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arg1, sha, option] = process.argv.slice(2);
  if (arg1 === "--cache-keys" && process.argv.length === 3) {
    const keys = await deepCacheKeys();
    for (const [name, value] of Object.entries(keys)) {
      console.log(`${name}=${value}`);
    }
  } else if (arg1 === "--ensure-playwright-chromium" && process.argv.length === 3) {
    ensurePlaywrightChromium();
  } else {
    assert.ok(
      process.argv.length <= 5 && (!option || option === "--plan"),
      "Usage: ci-deep.mjs browser|integration|electron SHA [--plan] | --cache-keys | --ensure-playwright-chromium",
    );
    validateDeepSource(sha);
    const commands = deepCommands(arg1);
    if (option === "--plan") console.log(JSON.stringify(commands));
    else runDeep(commands);
  }
}
