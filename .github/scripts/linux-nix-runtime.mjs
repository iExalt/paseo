import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import smoke from "../../packages/desktop/e2e/packaged-app-smoke.js";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  process.env.GITHUB_SHA,
);
const outputs = JSON.parse(
  await readFile(process.env.RUNNER_TEMP + "/linux-nix-outputs.json", "utf8"),
);
assert.equal(outputs.length, 2);
const daemon = await readFile(process.env.RUNNER_TEMP + "/linux-nix-daemon-path", "utf8");
const desktop = await readFile(process.env.RUNNER_TEMP + "/linux-nix-desktop-path", "utf8");
assert.deepEqual(outputs.map((built) => built.outputs.out).sort(), [daemon, desktop].sort());
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const artifactDir = resolve(".dev/github-workflows/linux-nix");
await mkdir(artifactDir, { recursive: true });
await writeFile(
  resolve(artifactDir, "identity.json"),
  JSON.stringify(
    {
      sourceSha: process.env.GITHUB_SHA,
      version,
      daemon,
      desktop,
      signing: "unsigned same-job verification; no release or transfer",
      outputs,
    },
    null,
    2,
  ),
);
await smoke.smokeNixLinuxDesktop({ daemon, desktop, version, artifactDir });
