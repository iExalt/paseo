import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

export function hasLiveAttemptJob(context, jobs) {
  return jobs.some(
    (job) =>
      job.run_id === context.runId &&
      job.run_attempt === context.attempt &&
      job.status === "in_progress" &&
      job.conclusion === null,
  );
}

export async function readAttemptJobs(context, request) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await request(
      `/repos/iExalt/paseo/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(result.jobs));
    for (const job of result.jobs) {
      assert.equal(job.run_id, context.runId);
      assert.equal(job.run_attempt, context.attempt);
    }
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
  throw new Error("Candidate job inventory exceeds bound");
}

// Runner expressions provide outcomes independently of the delayed steps API.
// The before/after observations bound execution; they are not API timestamps.
export function readStepProofs(log, job) {
  const lines = log.split(/\r?\n/).filter((line) => /^\S+ PASEO_STEP_PROOF=/.test(line));
  if (!lines.length) return null;
  const names = new Set();
  let number = 0,
    completed = Date.parse(job.started_at);
  const steps = lines.map((line) => {
    const match = line.match(/^([0-9T:.Z-]+) PASEO_STEP_PROOF=(\{.*\})$/);
    assert.ok(match, "Malformed controlled step proof");
    const proof = JSON.parse(match[2]);
    assert.deepEqual(
      Object.keys(proof).sort(),
      [
        "schemaVersion",
        "repository",
        "runId",
        "attempt",
        "name",
        "number",
        "outcome",
        "conclusion",
        "started_at",
        "completed_at",
      ].sort(),
    );
    assert.equal(proof.schemaVersion, 1);
    assert.equal(proof.repository, "iExalt/paseo");
    assert.equal(proof.runId, job.run_id);
    assert.equal(proof.attempt, job.run_attempt);
    assert.ok(typeof proof.name === "string" && proof.name.length > 0);
    assert.ok(!names.has(proof.name), "Duplicate controlled step proof");
    names.add(proof.name);
    assert.ok(Number.isSafeInteger(proof.number) && proof.number > number);
    const start = Date.parse(proof.started_at),
      end = Date.parse(proof.completed_at);
    assert.ok(start >= completed && end >= start);
    assert.ok(end <= Date.parse(job.completed_at) + 1000);
    assert.ok(Date.parse(match[1]) >= end && Date.parse(match[1]) < end + 1000);
    assert.ok(["success", "failure", "cancelled", "skipped"].includes(proof.outcome));
    // A continued failure must never become a successful proof.
    assert.equal(proof.outcome, proof.conclusion);
    number = proof.number;
    completed = end;
    return {
      name: proof.name,
      number,
      status: "completed",
      conclusion: proof.outcome,
      started_at: proof.started_at,
      completed_at: proof.completed_at,
    };
  });
  return steps;
}

// Reconcile the exact successful job. A controlled receipt is admissible only
// from its authenticated job log, with the same run and attempt and no duplicates.
export async function reconcileJobSteps(
  job,
  request,
  { wait = sleep, now = () => performance.now() } = {},
) {
  if (job.status !== "completed" || job.conclusion !== "success" || job.steps?.length) {
    return job;
  }
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
  const deadline = now() + 30000;
  const delays = [1000, 2000, 4000, 8000, 10000];
  for (let index = 0; ; index++) {
    assert.ok(now() < deadline, "Candidate job metadata polling deadline exceeded");
    const current = await request(`/repos/iExalt/paseo/actions/jobs/${job.id}`);
    for (const key of ["id", "run_id", "run_attempt", "name", "status", "conclusion"]) {
      assert.equal(current[key], job[key], `Candidate job ${key} changed`);
    }
    assert.ok(Array.isArray(current.steps), "Candidate job steps are unavailable");
    assert.ok(now() < deadline, "Candidate job metadata polling deadline exceeded");
    if (current.steps.length) return current;
    if (index === 0) {
      const steps = readStepProofs(
        await request(`/repos/iExalt/paseo/actions/jobs/${job.id}/logs`, { text: true }),
        current,
      );
      if (steps) return { ...current, steps, stepEvidence: "controlled-job-log-v1" };
    }
    assert.ok(index < delays.length, "Candidate job steps remained unavailable");
    await wait(Math.min(delays[index], deadline - now()));
  }
}
