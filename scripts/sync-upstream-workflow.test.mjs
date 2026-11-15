import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const yaml = createRequire(import.meta.url)("js-yaml");

const workflowPath = new URL("../.github/workflows/upstream-sync.yml", import.meta.url);
const workflowText = await readFile(workflowPath, "utf8");
const workflow = yaml.load(workflowText);
const [tokenStep, syncStep] = workflow.jobs.sync.steps;
const script = syncStep.with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeGithub({
  destinationSha,
  sourceSha,
  comparisonStatus,
  requestedRef,
  resolvedSha,
  membershipStatus = "ahead",
  failures = {},
}) {
  const calls = [];
  const github = {
    rest: {
      repos: {
        async getBranch(args) {
          calls.push(["getBranch", args]);
          if (failures.getBranch?.(args)) throw new Error("branch lookup failed");
          const sha = args.owner === "getpaseo" ? sourceSha : destinationSha;
          return { data: { commit: { sha } } };
        },
        async getCommit(args) {
          calls.push(["getCommit", args]);
          if (failures.getCommit) throw new Error("commit lookup failed");
          return { data: { sha: resolvedSha } };
        },
        async compareCommitsWithBasehead(args) {
          calls.push(["compareCommitsWithBasehead", args]);
          if (failures.compareCommitsWithBasehead) throw new Error("comparison failed");
          return {
            data: { status: args.owner === "getpaseo" ? membershipStatus : comparisonStatus },
          };
        },
      },
      git: {
        async updateRef(args) {
          calls.push(["updateRef", args]);
          if (failures.updateRef) throw new Error("ref update failed");
        },
      },
    },
  };
  const errors = [];
  const core = {
    info() {},
    setFailed(message) {
      errors.push(message);
    },
  };

  return {
    calls,
    errors,
    run: () =>
      new AsyncFunction("github", "core", "process", script)(github, core, {
        env: { UPSTREAM_REF: requestedRef },
      }),
  };
}

test("workflow is scheduled at 07:23 UTC and guarded to the fork dev branch", () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: "23 7 * * *" }]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.match(workflow.jobs.sync.if, /github\.repository == 'iExalt\/paseo'/);
  assert.match(workflow.jobs.sync.if, /github\.ref == 'refs\/heads\/dev'/);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.sync.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.sync["timeout-minutes"], 5);
  // GITHUB_TOKEN cannot move the mirror onto upstream commits that change workflows.
  assert.match(tokenStep.uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/);
  assert.equal(tokenStep.with["permission-contents"], "write");
  assert.equal(tokenStep.with["permission-workflows"], "write");
  assert.equal(syncStep.with["github-token"], "${{ steps.token.outputs.token }}");
  assert.equal(
    workflow.jobs.sync.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    false,
  );
});

test("matching refs skip comparison and update", async () => {
  const sha = "a".repeat(40);
  const mock = makeGithub({ destinationSha: sha, sourceSha: sha });

  await mock.run();

  assert.equal(mock.errors.length, 0);
  assert.equal(mock.calls.filter(([name]) => name === "compareCommitsWithBasehead").length, 0);
  assert.equal(mock.calls.filter(([name]) => name === "updateRef").length, 0);
});

test("source ahead of destination updates the mirror without force", async () => {
  const destinationSha = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const mock = makeGithub({ destinationSha, sourceSha, comparisonStatus: "ahead" });

  await mock.run();

  const compare = mock.calls.find(([name]) => name === "compareCommitsWithBasehead")[1];
  assert.deepEqual(
    mock.calls.filter(([name]) => name === "getBranch").map(([, args]) => args),
    [
      { owner: "iExalt", repo: "paseo", branch: "upstream/main" },
      { owner: "getpaseo", repo: "paseo", branch: "main" },
    ],
  );
  assert.deepEqual(compare, {
    owner: "iExalt",
    repo: "paseo",
    basehead: `iExalt:${destinationSha}...getpaseo:${sourceSha}`,
  });
  const update = mock.calls.find(([name]) => name === "updateRef")[1];
  assert.deepEqual(update, {
    owner: "iExalt",
    repo: "paseo",
    ref: "heads/upstream/main",
    sha: sourceSha,
    force: false,
  });
  assert.equal(mock.errors.length, 0);
});

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`${comparisonStatus} comparison refuses to update and fails`, async () => {
    const mock = makeGithub({
      destinationSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      comparisonStatus,
    });

    await mock.run();

    assert.equal(mock.calls.filter(([name]) => name === "updateRef").length, 0);
    assert.match(mock.errors[0], new RegExp(`status is ${comparisonStatus}`));
  });
}

test("branch lookup, comparison, and ref update failures are reported", async (context) => {
  const cases = [
    ["destination branch lookup", { getBranch: (args) => args.owner === "iExalt" }],
    ["source branch lookup", { getBranch: (args) => args.owner === "getpaseo" }],
    ["comparison", { compareCommitsWithBasehead: true }],
    ["ref update", { updateRef: true }],
  ];

  for (const [name, failures] of cases) {
    await context.test(name, async () => {
      const mock = makeGithub({
        destinationSha: "a".repeat(40),
        sourceSha: "b".repeat(40),
        comparisonStatus: "ahead",
        failures,
      });

      await mock.run();

      assert.equal(mock.errors.length, 1);
      assert.match(mock.errors[0], /failed/);
      if (failures.getBranch) {
        assert.equal(
          mock.calls.filter(([call]) => call === "compareCommitsWithBasehead").length,
          0,
        );
        assert.equal(mock.calls.filter(([call]) => call === "updateRef").length, 0);
      }
      if (failures.compareCommitsWithBasehead)
        assert.equal(mock.calls.filter(([call]) => call === "updateRef").length, 0);
    });
  }
});

for (const requestedRef of [
  "c".repeat(40),
  "refs/tags/reviewed",
  "'; throw new Error('injected'); //",
]) {
  test(`pinned ref resolves once as data and updates the exact ancestor: ${requestedRef}`, async () => {
    const resolvedSha = "c".repeat(40);
    const mock = makeGithub({
      destinationSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      requestedRef,
      resolvedSha,
      comparisonStatus: "ahead",
    });
    await mock.run();
    assert.deepEqual(mock.errors, []);
    assert.deepEqual(
      mock.calls.filter(([name]) => name === "getCommit"),
      [["getCommit", { owner: "getpaseo", repo: "paseo", ref: requestedRef }]],
    );
    assert.deepEqual(
      mock.calls
        .filter(([name]) => name === "compareCommitsWithBasehead")
        .map(([, args]) => args.basehead),
      [`${resolvedSha}...${"b".repeat(40)}`, `iExalt:${"a".repeat(40)}...getpaseo:${resolvedSha}`],
    );
    assert.equal(mock.calls.find(([name]) => name === "updateRef")[1].sha, resolvedSha);
  });
}
for (const membershipStatus of ["behind", "diverged"]) {
  test(`pin outside captured main refuses: ${membershipStatus}`, async () => {
    const mock = makeGithub({
      destinationSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      requestedRef: "topic",
      resolvedSha: "c".repeat(40),
      membershipStatus,
    });
    await mock.run();
    assert.match(mock.errors[0], /not on main/);
    assert.equal(
      mock.calls.some(([name]) => name === "updateRef"),
      false,
    );
  });
}
test("pinned no-op still proves membership; invalid resolution and lookup fail closed", async () => {
  const sha = "a".repeat(40);
  const mock = makeGithub({
    destinationSha: sha,
    sourceSha: "b".repeat(40),
    requestedRef: "pin",
    resolvedSha: sha,
  });
  await mock.run();
  assert.deepEqual(mock.errors, []);
  assert.equal(mock.calls.filter(([name]) => name === "compareCommitsWithBasehead").length, 1);
  assert.equal(
    mock.calls.some(([name]) => name === "updateRef"),
    false,
  );
  for (const extra of [{ resolvedSha: "bad" }, { failures: { getCommit: true } }]) {
    const failed = makeGithub({
      destinationSha: sha,
      sourceSha: "b".repeat(40),
      requestedRef: "pin",
      ...extra,
    });
    await failed.run();
    assert.equal(failed.errors.length, 1);
    assert.equal(
      failed.calls.some(([name]) => name === "updateRef"),
      false,
    );
  }
});
test("dispatch pin is passed through environment, never interpolated into script", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.ref.required, false);
  assert.equal(syncStep.env.UPSTREAM_REF, "${{ inputs.ref }}");
  assert.doesNotMatch(script, /\$\{\{.*inputs/);
});
