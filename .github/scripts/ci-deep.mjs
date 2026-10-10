import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const started = performance.now();
    const result = run(command, args, { cwd: root, stdio: "inherit", env: process.env });
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
    "Usage: ci-deep.mjs browser SHA [--plan]",
  );
  validateDeepSource(sha);
  const commands = deepCommands(lane);
  if (option === "--plan") console.log(JSON.stringify(commands));
  else runDeep(commands);
}
