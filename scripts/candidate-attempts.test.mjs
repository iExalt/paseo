import assert from "node:assert/strict";
import test from "node:test";
import { attemptLedger } from "../.github/scripts/candidate-attempts.mjs";

// Recorded from a disposable rerun probe (run 38507545059): f failed in attempt
// 1; "Re-run failed jobs" made attempt 2; rerunning only a made attempt 3.
// Start times and conclusions are verbatim; completion times were not
// recorded, so each execution gets a fixed 5 s duration that clones copy.
const RUN = 38507545059;
const starts = ["2026-10-14T03:41:23Z", "2026-10-14T03:41:50Z", "2026-10-14T03:42:16Z"];
const executions = {
  f: [
    ["03:41:27", "failure"],
    ["03:41:54", "success"],
    ["03:41:54", "success"],
  ],
  a: [
    ["03:41:26", "success"],
    ["03:41:26", "success"],
    ["03:42:21", "success"],
  ],
  p: [
    ["03:41:33", "success"],
    ["03:42:00", "success"],
    ["03:42:00", "success"],
  ],
  q: [
    ["03:41:37", "skipped"],
    ["03:42:07", "success"],
    ["03:42:27", "success"],
  ],
};

function job(name, attempt, [start, conclusion], id) {
  const started = Date.parse(`2026-10-14T${start}Z`);
  return {
    id,
    name,
    run_id: RUN,
    run_attempt: attempt,
    status: "completed",
    conclusion,
    started_at: new Date(started).toISOString().replace(".000", ""),
    completed_at: new Date(started + 5000).toISOString().replace(".000", ""),
  };
}

function fixture(edit = (jobs) => jobs) {
  const attempts = starts.map((started, index) => {
    const attempt = index + 1;
    const jobs = Object.entries(executions).map(([name, rows], offset) =>
      job(name, attempt, rows[index], attempt * 100 + offset),
    );
    return { run_started_at: started, jobs: edit(jobs, attempt) };
  });
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    const match = path.match(/\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?/);
    assert.equal(Number(match[1]), RUN);
    const attempt = Number(match[2]);
    const value = attempts[attempt - 1];
    if (match[3]) return { total_count: value.jobs.length, jobs: value.jobs };
    return { id: RUN, run_attempt: attempt, run_started_at: value.run_started_at };
  };
  return { request, calls };
}

test("carried-over jobs resolve to the attempt that actually executed them", async () => {
  const { request, calls } = fixture();
  const ledger = attemptLedger({ runId: RUN, attempt: 3 }, request);
  // f failed, then genuinely succeeded in 2; attempt 3 holds only its clone.
  assert.deepEqual(await ledger.producer("f"), {
    attempt: 2,
    job: job("f", 2, executions.f[1], 200),
  });
  // a ran in 1, was carried into 2, then the single-job rerun executed it in 3.
  assert.equal((await ledger.producer("a")).attempt, 3);
  // p re-executed in 2 as a dependent of f; its attempt-1 output is stale.
  assert.equal((await ledger.producer("p")).job.id, 202);
  assert.equal((await ledger.producer("q")).attempt, 3);
  assert.equal(calls.length, 6, "Each attempt is read once per invocation");
  const earlier = attemptLedger({ runId: RUN, attempt: 2 }, fixture().request);
  assert.equal((await earlier.producer("a")).job.id, 101, "Carried chain keeps attempt 1");
});

test("fails closed on failed, missing, duplicate or ambiguous executions", async () => {
  const at = (attempt, name, change) => (jobs, number) =>
    number === attempt ? jobs.map((item) => (item.name === name ? change(item) : item)) : jobs;
  const reject = async (edit, name, pattern) =>
    assert.rejects(
      attemptLedger({ runId: RUN, attempt: 3 }, fixture(edit).request).producer(name),
      pattern,
    );
  await reject(
    at(3, "a", (item) => ({ ...item, conclusion: "failure" })),
    "a",
    /did not succeed/,
  );
  await reject(
    at(3, "f", (item) => ({ ...item, completed_at: "2026-10-14T03:42:01Z" })),
    "f",
    /Ambiguous/,
  );
  await reject(
    (jobs, number) => (number === 3 ? jobs.filter((item) => item.name !== "p") : jobs),
    "p",
    /missing from attempt 3/,
  );
  await reject(
    (jobs, number) => (number === 2 ? [...jobs, { ...jobs[0], id: 999 }] : jobs),
    "f",
    /Duplicate/,
  );
  await reject(
    at(1, "f", (item) => ({ ...item, started_at: "2026-10-14T03:41:00Z" })),
    "f",
    /Ambiguous/,
  );
  await reject(() => [], "f", /No execution/);
  assert.throws(() => attemptLedger({ runId: RUN, attempt: 11 }, fixture().request), /bound/);
});
