import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { load } from "js-yaml";
import { readStepProofs, reconcileJobSteps } from "../.github/scripts/candidate-job-proof.mjs";

const job = {
  id: 42,
  run_id: 500,
  run_attempt: 2,
  name: "authorize",
  status: "completed",
  conclusion: "success",
  steps: [],
  started_at: "2026-10-13T20:00:00Z",
  completed_at: "2026-10-13T20:00:10Z",
};
const proof = {
  schemaVersion: 1,
  repository: "iExalt/paseo",
  runId: 500,
  attempt: 2,
  name: "Upload authenticated worker grant",
  number: 3,
  outcome: "success",
  conclusion: "success",
  started_at: "2026-10-13T20:00:01.000Z",
  completed_at: "2026-10-13T20:00:09.000Z",
};
const log = (value = proof) =>
  `2026-10-13T20:00:09.001Z PASEO_STEP_PROOF=${JSON.stringify(value)}\n`;

test("workflow receipts bind adjacent real step outcomes rather than asserted success", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  let receipts = 0;
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const workflow = load(readFileSync(new URL(file, directory), "utf8"));
    for (const definition of Object.values(workflow.jobs)) {
      const steps = definition.steps ?? [];
      for (let index = 0; index < steps.length; index++) {
        const end = steps[index];
        if (end.uses !== "./.github/actions/record-step" || !end.with.started) continue;
        const target = steps[index - 1],
          begin = steps[index - 2];
        assert.equal(begin.uses, end.uses);
        assert.equal(begin.with.name, target.name);
        assert.equal(end.with.name, target.name);
        assert.equal(end.with.number, begin.with.number);
        assert.equal(end.with.started, `\${{ steps.${begin.id}.outputs.started }}`);
        assert.equal(end.with.outcome, `\${{ steps.${target.id}.outcome }}`);
        assert.equal(end.with.conclusion, `\${{ steps.${target.id}.conclusion }}`);
        assert.equal(end.if, "${{ !cancelled() }}");
        receipts++;
      }
    }
  }
  assert.ok(receipts > 0);
});

test("controlled step receipts retain execution bounds and same-attempt successful outcomes", async () => {
  const result = await reconcileJobSteps(job, async (route, options) => {
    if (route.endsWith("/logs")) {
      assert.equal(options.text, true);
      return log();
    }
    assert.equal(route, "/repos/iExalt/paseo/actions/jobs/42");
    return job;
  });
  assert.equal(result.stepEvidence, "controlled-job-log-v1");
  assert.equal(result.steps[0].conclusion, "success");
  assert.equal(result.steps[0].started_at, proof.started_at);
  for (const delta of [
    { repository: "another/repository" },
    { runId: 501 },
    { attempt: 1 },
    { number: 0 },
    { outcome: "failure" },
    { extra: true },
    { started_at: "2026-10-13T19:59:59Z" },
    { completed_at: "2026-10-13T20:00:12Z" },
  ])
    assert.throws(() => readStepProofs(log({ ...proof, ...delta }), job));
  assert.throws(() => readStepProofs(log() + log(), job), /Duplicate/);
  assert.equal(readStepProofs("no receipt", job), null);
  const skipped = readStepProofs(log({ ...proof, outcome: "skipped", conclusion: "skipped" }), job);
  assert.equal(skipped[0].conclusion, "skipped");
});
