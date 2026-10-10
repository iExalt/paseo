import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import {
  changedFiles,
  coreTests,
  executeCommands,
  helperTests,
  packageTests,
  planCommands,
  planLane,
  planMatrix,
  lanes,
  root,
  selectChecks,
  vitestHelpers,
} from "../.github/scripts/ci-routine.mjs";

const filters = JSON.parse(readFileSync(join(root, ".github/ci-paths.json"), "utf8"));
const workflow = load(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));

test("routing includes dependent contracts and fails toward full checks for unknown/config paths", () => {
  const all = selectChecks(null, filters).domains;
  for (const file of [
    "mise.toml",
    ".mise/tasks/ci/routine",
    ".github/scripts/new.mjs",
    "new-config.toml",
    "packages/relay/src/index.ts",
  ]) {
    assert.deepEqual(selectChecks([file], filters).domains, all, file);
  }
  assert.deepEqual(selectChecks(["packages/client/src/a.ts"], filters).domains, [
    "sdk",
    "server",
    "cli",
    "app",
    "desktop",
  ]);
  assert.deepEqual(selectChecks(["packages/server/src/a.ts"], filters).domains, [
    "server",
    "cli",
    "desktop",
  ]);
  assert.deepEqual(selectChecks(["packages/cli/src/a.ts"], filters).domains, ["cli", "desktop"]);
  assert.deepEqual(selectChecks(["packages/app/src/a.tsx"], filters).domains, ["app", "desktop"]);
  assert.deepEqual(selectChecks(["packages/app/src/desktop/a.ts"], filters).domains, [
    "app",
    "desktop",
  ]);
  assert.equal(selectChecks(["docs/guide.md"], filters).code, false);
  assert.equal(selectChecks(["public-docs/plugins/guide.md"], filters).code, true);
  assert.equal(selectChecks(["scripts/prompt.md"], filters).code, true);
  assert.equal(selectChecks([], filters).code, false);
  assert.throws(() => selectChecks(["../outside"], filters));
  // Actual YAML brace/glob patterns must match; the browser extglob excludes desktop.
  assert.ok(
    filters.browser.some((glob) =>
      matchesGlob("packages/server/src/server/plugins/runtime.ts", glob),
    ),
  );
  assert.ok(filters.browser.some((glob) => matchesGlob("packages/app/src/chat/a.ts", glob)));
  assert.ok(!filters.browser.some((glob) => matchesGlob("packages/app/src/desktop/a.ts", glob)));
});

test("Git routing includes both rename sides and deleted paths without API truncation", () => {
  const fixture = mkdtempSync(join(tmpdir(), "paseo-ci-diff-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "CI fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "CI fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  try {
    git("init", "-q");
    mkdirSync(join(fixture, "docs"));
    writeFileSync(join(fixture, "old.ts"), "old");
    writeFileSync(join(fixture, "deleted.ts"), "deleted");
    git("add", ".");
    git("commit", "-qm", "test: base");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.ts", "docs/renamed.md");
    git("rm", "-q", "deleted.ts");
    writeFileSync(join(fixture, "docs/space name.md"), "new");
    git("add", ".");
    git("commit", "-qm", "test: changes");
    assert.deepEqual(changedFiles(base, fixture).sort(), [
      "deleted.ts",
      "docs/renamed.md",
      "docs/space name.md",
      "old.ts",
    ]);
    assert.throws(() => changedFiles("not-a-sha", fixture));
    assert.throws(() => changedFiles("f".repeat(40), fixture));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("routine builds once, keeps cheap units and narrowly filters paid integration", () => {
  const commands = planCommands(selectChecks(null, filters));
  assert.equal(commands.filter((step) => step.args.includes("build:server")).length, 1);
  const app = commands.find((step) => step.name === "app units");
  assert.ok(app.args.includes("unit"));
  const cli = commands.find((step) => step.name === "cli units");
  assert.ok(cli.args.includes("**/*.e2e.test.ts"));
  const desktop = commands.find((step) => step.name === "desktop units");
  assert.ok(desktop.args.includes("scripts/after-pack.test.mjs"));
  assert.ok(
    commands
      .find((step) => step.name === "workflow and helper contracts")
      .args.includes("packages/desktop/scripts/after-pack.test.mjs"),
  );
  assert.ok(
    !commands.some(
      (step) => step.args.includes("test:local") || step.args.includes("test:browser"),
    ),
  );
  const integration = commands.find((step) => step.name === "focused server integration");
  const pattern = new RegExp(integration.args.at(-1));
  assert.equal(
    pattern.test("Antigravity creates an agent and answers a prompt with real agy"),
    false,
  );
  assert.equal(pattern.test("daemon E2E listProviderModels lists Antigravity models"), true);
  assert.equal(
    commands.find((step) => step.name === "versioned OpenCode runtime").args.at(-1),
    "versioned runtime",
  );
  const docs = planCommands(selectChecks(["docs/GITHUB_WORKFLOWS_PLAN.md"], filters));
  assert.deepEqual(
    docs.map((step) => step.name),
    ["format", "workflow expressions", "workflow and helper contracts"],
  );
  assert.ok(
    !docs
      .find((step) => step.name === "workflow and helper contracts")
      .args.includes(helperTests[0]),
  );
  assert.ok(
    commands
      .find((step) => step.name === "workflow and helper contracts")
      .args.includes(helperTests[0]),
  );
});

test("new Node test files require an explicit routine or G3 classification", () => {
  const actual = readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `scripts/${name}`)
    .sort();
  const classified = [...coreTests, ...helperTests, ...vitestHelpers, ...packageTests]
    .filter((name) => name.startsWith("scripts/"))
    .sort();
  assert.deepEqual(classified, actual);
  assert.equal(new Set(classified).size, classified.length);
  for (const name of [...coreTests, ...helperTests]) {
    assert.match(readFileSync(join(root, name), "utf8"), /from "node:test"/);
  }
  for (const name of vitestHelpers) {
    assert.match(readFileSync(join(root, name), "utf8"), /from "vitest"/);
  }
  const commands = planCommands(selectChecks(null, filters));
  const node = commands.find((step) => step.name === "workflow and helper contracts");
  const vitest = commands.find((step) => step.name === "Vitest helper contracts");
  for (const name of vitestHelpers) {
    assert.ok(!node.args.includes(name));
    assert.ok(vitest.args.includes(name));
  }
});

test("parallel lanes partition every selected check, with only declared prerequisites duplicated", () => {
  for (const files of [
    null,
    [],
    ["docs/guide.md"],
    ["packages/app/src/a.ts"],
    ["packages/server/src/a.ts"],
    ["packages/client/src/a.ts"],
  ]) {
    const selection = selectChecks(files, filters);
    const complete = planCommands(selection);
    const matrix = planMatrix(selection);
    assert.equal(new Set(matrix.lane).size, matrix.lane.length);
    assert.ok(matrix.lane.includes("quality"));
    const seen = [];
    for (const lane of lanes) {
      const commands = planLane(selection, lane);
      assert.equal(matrix.lane.includes(lane), commands.length > 0);
      for (const step of commands) {
        if (step.name === "workspace declarations" && lane !== "quality") continue;
        if (step.name === "server units") {
          assert.equal(step.args.at(-1), `--shard=${lane.at(-1)}/3`);
          assert.deepEqual(
            step.args.slice(0, -1),
            complete.find((item) => item.name === step.name).args,
          );
        } else
          assert.deepEqual(
            step,
            complete.find((item) => item.name === step.name),
          );
        if (step.name !== "server units" || lane === "server-1") seen.push(step.name);
      }
    }
    assert.deepEqual(seen.sort(), complete.map((step) => step.name).sort());
    assert.deepEqual(
      matrix.lane.filter((lane) => lane.startsWith("server-")),
      selection.domains.includes("server") ? ["server-1", "server-2", "server-3"] : [],
    );
  }
  assert.throws(() => planLane(selectChecks(null, filters), "unknown"));
});

test("matrix planning works in a checkout without installed dependencies", () => {
  const fixture = mkdtempSync(join(tmpdir(), "paseo-ci-plan-"));
  try {
    mkdirSync(join(fixture, ".github/scripts"), { recursive: true });
    for (const file of [".github/scripts/ci-routine.mjs", ".github/ci-paths.json"]) {
      writeFileSync(join(fixture, file), readFileSync(join(root, file)));
    }
    const result = spawnSync(process.execPath, [".github/scripts/ci-routine.mjs", "--matrix"], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { lane: lanes });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("hosted planner propagates failure before emitting a matrix", () => {
  const fixture = mkdtempSync(join(tmpdir(), "paseo-ci-output-"));
  const output = join(fixture, "output");
  writeFileSync(output, "");
  try {
    const script = workflow.jobs.plan.steps.find((step) => step.id === "plan").run;
    const result = spawnSync("bash", ["-e", "-c", `node() { return 7; }\n${script}`], {
      env: { ...process.env, EVENT_NAME: "push", GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(output, "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("execution propagates a failing check and never reaches later commands", () => {
  const commands = [
    { name: "first", command: "test", args: [] },
    { name: "later", command: "test", args: [] },
  ];
  let calls = 0;
  assert.equal(
    executeCommands(
      commands,
      () => {
        calls++;
        return { status: 7 };
      },
      () => {},
    ),
    7,
  );
  assert.equal(calls, 1);
  assert.equal(
    executeCommands(
      commands,
      () => ({ status: null, error: new Error("spawn") }),
      () => {},
    ),
    1,
  );
  assert.equal(
    executeCommands(
      commands,
      () => ({ status: 0 }),
      () => {},
    ),
    0,
  );
});

test("real mise file task resolves the repository from a package and forwards arguments", () => {
  const result = spawnSync("mise", ["run", "--skip-tools", "ci:routine", "--plan"], {
    cwd: join(root, "packages/app"),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MISE_TASK_RUN_AUTO_INSTALL: "false" },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.selection.code, true);
  assert.ok(plan.commands.some((step) => step.args.includes("build:server")));
  const invalid = spawnSync("mise", ["run", "--skip-tools", "ci:routine", "--unexpected"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MISE_TASK_RUN_AUTO_INSTALL: "false" },
  });
  assert.notEqual(invalid.status, 0);
});

test("workflow aggregate rejects every incomplete result without ineffective cache transfers", () => {
  assert.deepEqual(workflow.on.push.branches, ["dev"]);
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(workflow.jobs.required.if, "always()");
  assert.deepEqual(workflow.jobs.required.needs, ["plan", "routine"]);
  const gate = workflow.jobs.required.steps[0].run;
  for (const plan of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
      const status = spawnSync("bash", ["-c", gate], {
        env: { ...process.env, RESULT: result, PLAN_RESULT: plan },
      }).status;
      assert.equal(status === 0, result === "success" && plan === "success");
    }
  }
  assert.equal(workflow.jobs.routine.strategy["fail-fast"], false);
  assert.equal(workflow.jobs.routine.strategy["max-parallel"], lanes.length);
  assert.ok(!workflow.jobs.plan.steps.some((step) => step.run?.includes("npm ci")));
  const steps = workflow.jobs.routine.steps;
  assert.ok(!steps.some((step) => step.uses?.startsWith("actions/cache")));
  const setup = steps.find((step) => step.name === "Configure pinned npm installation");
  assert.match(setup.run, /npm_config_cache=\$RUNNER_TEMP\/npm-cache/);
  assert.match(setup.run, /v26\.11\.0/);
  assert.match(setup.run, /11\.20\.0/);
  assert.ok(!steps.some((step) => step.uses?.includes("upload-artifact")));
  assert.equal(steps.find((step) => step.uses?.startsWith("jdx/mise-action@")).with.cache, false);
});
