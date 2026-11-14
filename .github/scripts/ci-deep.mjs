import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeepCleanup } from "./deep-cleanup.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));

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
        "npm",
        [
          "exec",
          "--",
          "vitest",
          "run",
          "packages/cli/src/commands/daemon/lifecycle.e2e.test.ts",
          "--maxWorkers=1",
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
      [
        "sudo",
        [
          "apt-get",
          "install",
          "-y",
          "xvfb",
          "xdotool",
          "libnss3",
          "libatk-bridge2.0-0",
          "libcups2",
          "libgbm1",
          "libasound2t64",
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
    [
      "npm",
      [
        "exec",
        "--workspace=@getpaseo/app",
        "--",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ],
    ],
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

export function runDeep(commands, run = spawnSync) {
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
      verifyDeepCleanup(owner);
    }
    console.log(
      `[deep] ${command} ${args.join(" ")}: ${((performance.now() - started) / 1000).toFixed(2)}s`,
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Deep command failed: ${command} ${args.join(" ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lane, sha, option] = process.argv.slice(2);
  assert.ok(
    process.argv.length <= 5 && (!option || option === "--plan"),
    "Usage: ci-deep.mjs browser|integration|electron SHA [--plan]",
  );
  validateDeepSource(sha);
  const commands = deepCommands(lane);
  if (option === "--plan") console.log(JSON.stringify(commands));
  else runDeep(commands);
}
