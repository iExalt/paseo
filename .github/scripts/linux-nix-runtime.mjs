import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import smoke from "../../packages/desktop/e2e/packaged-app-smoke.js";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "linux");
assert.ok(["x64", "arm64"].includes(process.env.EXPECTED_ARCHITECTURE));
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
);
const outputs = JSON.parse(
  await readFile(process.env.RUNNER_TEMP + "/linux-nix-outputs.json", "utf8"),
);
assert.equal(outputs.length, 2);
const daemon = await readFile(process.env.RUNNER_TEMP + "/linux-nix-daemon-path", "utf8");
const desktop = await readFile(process.env.RUNNER_TEMP + "/linux-nix-desktop-path", "utf8");
assert.deepEqual(outputs.map((built) => built.outputs.out).sort(), [daemon, desktop].sort());
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const previousOutputs = JSON.parse(
  await readFile(process.env.RUNNER_TEMP + "/linux-nix-previous-outputs.json", "utf8"),
);
assert.equal(previousOutputs.length, 2);
const previousDaemon = await readFile(
  process.env.RUNNER_TEMP + "/linux-nix-previous-daemon-path",
  "utf8",
);
const previousDesktop = await readFile(
  process.env.RUNNER_TEMP + "/linux-nix-previous-desktop-path",
  "utf8",
);
assert.deepEqual(
  previousOutputs.map((built) => built.outputs.out).sort(),
  [previousDaemon, previousDesktop].sort(),
);
const override = await readFile(".github/scripts/linux-previous-packages.nix");
const artifactDir = resolve(".dev/github-workflows/linux-nix");
await mkdir(artifactDir, { recursive: true });
await writeFile(
  resolve(artifactDir, "identity.json"),
  JSON.stringify(
    {
      sourceSha: process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
      architecture: process.arch,
      version,
      daemon,
      desktop,
      signing: "unsigned same-job verification; no release or transfer",
      outputs,
      previous: {
        sourceSha: "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a",
        version: "0.11.0",
        provenance:
          "rebuilt predecessor with explicit packaging-only RE2 asset repair; not a published Linux artifact",
        overrideSha256: createHash("sha256").update(override).digest("hex"),
        daemon: previousDaemon,
        desktop: previousDesktop,
        outputs: previousOutputs,
      },
    },
    null,
    2,
  ),
);
await smoke.smokePackagedDesktopUpgrade({
  previousApp: previousDesktop,
  candidateApp: desktop,
  artifactDir,
  nixPackages: {
    previous: { daemon: previousDaemon, version: "0.11.0" },
    candidate: { daemon, version },
  },
});
