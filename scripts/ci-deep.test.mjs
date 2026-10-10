import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import { deepCommands, runDeep, validateDeepSource } from "../.github/scripts/ci-deep.mjs";
import {
  elevatedOwnedProcesses,
  ownedProcesses,
  verifyDeepCleanup,
} from "../.github/scripts/deep-cleanup.mjs";

test("elevated cleanup is hosted-only, PID-only and fails closed", () => {
  const owner = randomUUID();
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  const run = (command, args, options) => {
    assert.equal(command, "sudo");
    assert.ok(args.includes(process.execPath));
    assert.deepEqual(args.slice(-3), ["--scan", "1001", owner]);
    assert.equal(options.timeout, 5_000);
    assert.equal(options.maxBuffer, 16 * 1024);
    return "[123]";
  };
  assert.deepEqual(elevatedOwnedProcesses(owner, { env, uid: 1001, run }), [123]);
  for (const invalid of [
    {},
    { GITHUB_ACTIONS: "true" },
    { ...env, RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    assert.throws(
      () => elevatedOwnedProcesses(owner, { env: invalid, uid: 1001, run }),
      /GitHub-hosted only/,
    );
  }
  assert.throws(() => elevatedOwnedProcesses(owner, { env, uid: -1, run }), /Invalid original UID/);
  assert.throws(() => elevatedOwnedProcesses("-".repeat(36), { env, uid: 1001, run }));
  for (const output of ["not json", "{}", "[0]", "[1,1]", '["123"]']) {
    assert.throws(() => elevatedOwnedProcesses(owner, { env, uid: 1001, run: () => output }));
  }
  assert.throws(
    () =>
      elevatedOwnedProcesses(owner, {
        env,
        uid: 1001,
        run: () => {
          throw new Error("sudo denied");
        },
      }),
    /sudo denied/,
  );
});

test(
  "cleanup detects a marked child and clears after its owned fixture exits",
  { skip: process.platform !== "linux" },
  async () => {
    const owner = randomUUID();
    const child = spawn("sleep", ["30"], { env: { ...process.env, CI_DEEP_OWNER: owner } });
    try {
      await once(child, "spawn");
      assert.ok(ownedProcesses(owner).includes(child.pid));
      assert.deepEqual(ownedProcesses(randomUUID()), []);
      assert.throws(() => verifyDeepCleanup(owner, 0), /leaked marked processes/);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    verifyDeepCleanup(owner, 0);
  },
);

test("deep configuration cannot inherit paid-provider or deployment projects", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import loaded from './packages/app/playwright.deep.config.ts';
    const config = loaded.default ?? loaded;
    assert.deepEqual(config.projects.map(project => project.name), ['browser']);
    assert.deepEqual(config.testMatch, ['new-workspace-launch-terminal.spec.ts']);
    assert.equal(config.workers, 1);
    assert.equal(config.retries, 0);
    assert.equal(config.use.trace, 'on');
    assert.equal(config.use.screenshot, 'on');
  `,
    ],
    { cwd: new URL("../", import.meta.url), stdio: "pipe" },
  );
});

test("deep workflow admits only opt-in owned PRs or exact trusted candidates", () => {
  const workflow = load(
    readFileSync(new URL("../.github/workflows/ci-deep.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(!("pull_request_target" in workflow.on));
  const sha = "a".repeat(40);
  const pr = {
    repository: "iExalt/paseo",
    event_name: "pull_request",
    event: {
      repository: { private: false },
      pull_request: {
        head: {
          repo: { full_name: "iExalt/paseo", owner: { login: "iExalt" } },
          ref: "ci/github-workflows",
          sha,
        },
        labels: [{ name: "ci:deep" }],
      },
    },
  };
  // GitHub's label projection is the only non-JavaScript syntax in this guard.
  const evaluate = new Function(
    "github",
    "inputs",
    "contains",
    `return (${workflow.jobs.browser.if.replace("labels.*.name", "labels.map(label => label.name)")});`,
  );
  const check = (github, inputs = {}) =>
    Boolean(evaluate(github, inputs, (array, value) => array.includes(value)));
  assert.equal(check(pr), true);
  for (const mutate of [
    (x) => {
      x.event.repository.private = true;
    },
    (x) => {
      x.event.pull_request.labels = [];
    },
    (x) => {
      x.event.pull_request.head.repo.full_name = "outsider/paseo";
    },
    (x) => {
      x.event.pull_request.head.ref = "other";
    },
  ]) {
    const rejected = structuredClone(pr);
    mutate(rejected);
    assert.equal(check(rejected), false);
  }
  const caller = { ...pr, event_name: "push", ref: "refs/heads/dev", sha, actor: "iExalt" };
  assert.equal(check(caller, { source_sha: sha }), true);
  assert.equal(check(caller, { source_sha: "dev" }), false);
  assert.equal(check({ ...caller, actor: "other" }, { source_sha: sha }), false);
  assert.equal(check({ ...caller, ref: "refs/heads/other" }, { source_sha: sha }), false);
});

test("deep verification requires exact source and isolated harness configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "deep-source-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: fixture",
    );
    const sha = git("rev-parse", "HEAD");
    validateDeepSource(sha, cwd, {});
    assert.throws(() => validateDeepSource("dev", cwd, {}), /full captured SHA/);
    assert.throws(() => validateDeepSource("0".repeat(40), cwd, {}), /captured source/);
    for (const key of [
      "E2E_FORK_PASEO_HOME_FROM",
      "E2E_BASE_URL",
      "E2E_PASEO_HOME",
      "PASEO_REPLICA_CACHE_MEASUREMENT",
    ]) {
      assert.throws(
        () => validateDeepSource(sha, cwd, { [key]: "unsafe" }),
        /environment override/,
      );
    }
    writeFileSync(join(cwd, ".env.test"), "E2E_BASE_URL=http://localhost:6767\n");
    assert.throws(() => validateDeepSource(sha, cwd, {}), /rejects .env.test/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("deep entrypoint stops at a failed prerequisite or journey", () => {
  const commands = deepCommands("browser");
  assert.throws(() => deepCommands("real-provider"), /Unknown deep lane/);
  for (let failure = 0; failure < commands.length; failure++) {
    let calls = 0;
    assert.throws(
      () => runDeep(commands, () => ({ status: calls++ === failure ? 1 : 0 })),
      /Deep command failed/,
    );
    assert.equal(calls, failure + 1);
  }
});
