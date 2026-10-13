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

// The list endpoint can omit steps for a completed job. Reconcile against that
// exact job; missing metadata never substitutes for a successful required step.
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
    assert.ok(index < delays.length, "Candidate job steps remained unavailable");
    await wait(Math.min(delays[index], deadline - now()));
  }
}
