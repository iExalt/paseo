import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const yaml = createRequire(import.meta.url)("js-yaml");

const workflowPath = new URL("../.github/workflows/upstream-sync.yml", import.meta.url);
const workflowText = await readFile(workflowPath, "utf8");
const workflow = yaml.load(workflowText);
const script = workflow.jobs.sync.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeGithub({ destinationSha, sourceSha, comparisonStatus, failures = {} }) {
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
        async compareCommitsWithBasehead(args) {
          calls.push(["compareCommitsWithBasehead", args]);
          if (failures.compareCommitsWithBasehead) throw new Error("comparison failed");
          return { data: { status: comparisonStatus } };
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

  return { calls, errors, run: () => new AsyncFunction("github", "core", script)(github, core) };
}

test("workflow is scheduled at 07:23 UTC and guarded to the fork dev branch", () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: "23 7 * * *" }]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.match(workflow.jobs.sync.if, /github\.repository == 'iExalt\/paseo'/);
  assert.match(workflow.jobs.sync.if, /github\.ref == 'refs\/heads\/dev'/);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.sync.permissions, { contents: "write" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.sync["timeout-minutes"], 5);
  assert.equal(workflow.jobs.sync.steps[0].with["github-token"], "${{ secrets.GITHUB_TOKEN }}");
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
