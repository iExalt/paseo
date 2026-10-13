import assert from "node:assert/strict";

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
