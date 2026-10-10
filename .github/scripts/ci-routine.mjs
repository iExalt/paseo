import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const coreTests = [
  "scripts/ci-workflow.test.mjs",
  "scripts/ci-routine.test.mjs",
  "scripts/sync-upstream-workflow.test.mjs",
  "scripts/release-version-utils.test.mjs",
  ".github/scripts/rebase-dev.test.mjs",
];
export const helperTests = [
  "packages/desktop/scripts/after-pack.test.mjs",
  "scripts/daemon-launch-contract.test.mjs",
  "scripts/is-main-module.test.mjs",
  "scripts/paseo-nix-update.test.mjs",
  "scripts/postinstall-patches-target.test.mjs",
  "scripts/promote-fork-release.test.mjs",
  "scripts/sync-fdroid-changelogs.test.mjs",
  "scripts/sync-release-notes-from-changelog.test.mjs",
  "scripts/upload-release-assets.test.mjs",
];
export const vitestHelpers = [
  "scripts/merge-mac-manifest.test.mjs",
  "scripts/stamp-rollout.test.mjs",
  "scripts/validate-desktop-manifests.test.mjs",
];
export const packageTests = [
  "scripts/builtin-plugins-dist.test.mjs",
  "scripts/trace-daemon-dist.test.mjs",
]; // Mandatory G3, alongside the Nix signature and macOS reactivation fixtures.
const domains = ["sdk", "relay", "server", "cli", "app", "desktop"];
const ownership = [...domains, "hub", "browser"];
const docs = ["docs/**", "public-docs/**", "README.md", "CONTRIBUTING.md", "CLAUDE.md"];

export function changedFiles(base, cwd = root) {
  assert.match(base, /^[a-f0-9]{40}$/, "Changed base must be a full captured commit SHA");
  return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function selectChecks(files, filters) {
  if (files === null) return { code: true, domains: [...domains], files: null };
  assert.ok(Array.isArray(files));
  const selected = new Set();
  let code = false;
  for (const file of files) {
    assert.ok(
      typeof file === "string" &&
        file.length &&
        !file.startsWith("/") &&
        !file.split("/").includes("..") &&
        !file.includes("\0"),
      "Invalid changed path",
    );
    const hit = (group) => filters[group].some((pattern) => matchesGlob(file, pattern));
    if (["workspace", "ci", "routing"].some(hit)) {
      return { code: true, domains: [...domains], files };
    }
    const owners = ownership.filter(hit);
    if (owners.length) {
      code = true;
      for (const owner of owners) {
        if (owner === "hub") selected.add("server").add("cli");
        else if (owner === "browser") selected.add("app");
        else selected.add(owner);
      }
    } else if (!docs.some((pattern) => matchesGlob(file, pattern))) {
      // Unknown paths, including new configuration and source, fail toward more checks.
      return { code: true, domains: [...domains], files };
    }
  }
  if (selected.has("relay")) selected.add("sdk");
  if (selected.has("sdk"))
    for (const name of ["server", "cli", "app", "desktop"]) selected.add(name);
  if (selected.has("server")) selected.add("cli").add("desktop");
  if (selected.has("cli") || selected.has("app")) selected.add("desktop");
  return { code, domains: domains.filter((name) => selected.has(name)), files };
}

export function planCommands(selection, cwd = root) {
  const commands = [];
  const add = (name, command, args) => commands.push({ name, command, args });
  const npm = (name, script, args = []) => add(name, "npm", ["run", script, ...args]);
  const unit = (workspace, script = "test", args = []) =>
    npm(`${workspace} units`, script, [
      `--workspace=@getpaseo/${workspace}`,
      "--",
      ...args,
      "--maxWorkers=2",
    ]);
  if (selection.files === null) npm("format", "format:check");
  else {
    const files = selection.files.filter(
      (file) =>
        /\.(?:cjs|css|html|js|json|jsonc|jsx|md|mjs|ts|tsx|yaml|yml)$/.test(file) &&
        existsSync(resolve(cwd, file)),
    );
    if (files.length)
      npm("format", "format:check:files", ["--", ...files.map((file) => `./${file}`)]);
  }
  add("workflow expressions", "mise", [
    "exec",
    "actionlint@1.7.12",
    "--",
    "actionlint",
    "-shellcheck=",
    "-pyflakes=",
  ]);
  add("workflow and helper contracts", process.execPath, [
    "--test",
    "--test-concurrency=2",
    ...coreTests,
    ...(selection.code ? helperTests : []),
  ]);
  if (!selection.code) return commands;
  add("Vitest helper contracts", "npm", [
    "exec",
    "--",
    "vitest",
    "run",
    "--maxWorkers=2",
    ...vitestHelpers,
  ]);
  npm("lint", "lint");
  npm("workspace declarations", "build:server");
  npm("types", "typecheck");
  if (selection.domains.includes("sdk"))
    for (const name of ["protocol", "client", "plugin", "highlight"]) unit(name);
  if (selection.domains.includes("relay")) unit("relay");
  if (selection.domains.includes("server")) {
    unit("builtin-plugins");
    unit("server", "test:unit");
  }
  if (selection.domains.includes("cli"))
    unit("cli", "test:unit", ["--exclude", "**/*.e2e.test.ts"]);
  if (selection.domains.includes("app")) unit("app", "test", ["--project", "unit"]);
  if (selection.domains.includes("desktop"))
    unit("desktop", "test", ["--exclude", "scripts/after-pack.test.mjs"]);
  if (selection.domains.includes("server")) {
    const integration = (name, files, args = []) =>
      add(name, "npm", [
        "exec",
        "--workspace=@getpaseo/server",
        "--",
        "vitest",
        "run",
        "--maxWorkers=1",
        ...files,
        ...args,
      ]);
    integration(
      "focused server integration",
      [
        "src/server/creation/creation.e2e.test.ts",
        "src/server/daemon-e2e/terminal-workspace-sdk.e2e.test.ts",
        "src/server/daemon-e2e/models.e2e.test.ts",
        "src/server/daemon-e2e/live-preferences.e2e.test.ts",
        "src/server/agent/model-catalog.e2e.test.ts",
        "src/server/plugins/plugin-paseo-api.e2e.test.ts",
      ],
      ["-t", "^(?!.*Antigravity creates an agent and answers a prompt with real agy).*$"],
    );
    integration(
      "worktree autoarchive",
      ["src/server/session.create-agent-worktree-autoarchive.e2e.test.ts"],
      ["-t", "creates a worktree and auto-archives both"],
    );
    integration(
      "versioned OpenCode runtime",
      ["src/server/agent/providers/opencode-bridge.local.e2e.test.ts"],
      ["-t", "versioned runtime"],
    );
  }
  return commands;
}

export function executeCommands(
  commands,
  run = (command, args) =>
    spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      timeout: 20 * 60 * 1000,
    }),
  report = console.log,
) {
  for (const step of commands) {
    const start = performance.now();
    report(`Starting ${step.name}`);
    const result = run(step.command, step.args);
    report(
      `${step.name}: ${((performance.now() - start) / 1000).toFixed(2)}s, exit ${result.status ?? "error"}`,
    );
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const planOnly = args.includes("--plan");
  const filtered = args.filter((arg) => arg !== "--plan");
  assert.ok(
    filtered.length === 0 || (filtered.length === 2 && filtered[0] === "--changed-from"),
    "Usage: ci:routine [--plan] [--changed-from <full-sha>]",
  );
  const filters = load(readFileSync(new URL("../ci-paths.yml", import.meta.url), "utf8"));
  const selection = selectChecks(filtered.length ? changedFiles(filtered[1]) : null, filters);
  const commands = planCommands(selection);
  if (planOnly) console.log(JSON.stringify({ selection, commands }, null, 2));
  else {
    console.log(
      `Routine source: ${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`,
    );
    const report = (line) => {
      console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
    };
    process.exitCode = executeCommands(commands, undefined, report);
  }
}
