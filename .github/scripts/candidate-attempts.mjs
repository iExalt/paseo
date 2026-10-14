import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readAttemptJobs } from "./candidate-job-proof.mjs";

export const MAX_RUN_ATTEMPTS = 10;

function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
  return value;
}

function time(value, label) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `Missing ${label} timestamp`);
  return parsed;
}

// "Re-run failed jobs" carries each earlier success into the new attempt as a
// clone: a new job id and run_attempt, but the original timestamps and logs.
// Only a job that started after its attempt began actually executed there, so
// proofs, artifacts and receipts must come from that execution, never a clone.
function classify(entry, previous) {
  if (!entry.job) return "absent";
  if (time(entry.job.started_at, "job start") >= entry.started) return "genuine";
  const source = previous?.job;
  assert.ok(
    source &&
      source.started_at === entry.job.started_at &&
      source.completed_at === entry.job.completed_at &&
      source.conclusion === entry.job.conclusion,
    `Ambiguous carried-over job ${entry.job.name} in attempt ${entry.attempt}`,
  );
  return "clone";
}

export function attemptLedger(context, request) {
  const runId = positive(context.runId);
  const current = positive(context.attempt);
  assert.ok(current <= MAX_RUN_ATTEMPTS, "Candidate run exceeds its attempt bound");
  const cache = new Map();
  function attempt(number) {
    if (!cache.has(number))
      cache.set(
        number,
        (async () => {
          // The run object moves with each attempt; only the attempt record
          // fixes when that attempt started.
          const run = await request(`/repos/iExalt/paseo/actions/runs/${runId}/attempts/${number}`);
          assert.equal(run.id, runId);
          assert.equal(run.run_attempt, number);
          return {
            attempt: number,
            started: time(run.run_started_at, "attempt start"),
            jobs: await readAttemptJobs({ runId, attempt: number }, request),
          };
        })(),
      );
    return cache.get(number);
  }

  return {
    /** Returns the attempt and genuine job record that produced a completed job. */
    async producer(name) {
      assert.ok(typeof name === "string" && name.length > 0);
      const entries = [];
      for (let number = 1; number <= current; number++) {
        const { started, jobs } = await attempt(number);
        const matches = jobs.filter((job) => job.name === name);
        assert.ok(matches.length <= 1, `Duplicate job ${name} in attempt ${number}`);
        entries.push({ attempt: number, started, job: matches[0] ?? null });
      }
      const kinds = entries.map((entry, index) => classify(entry, entries[index - 1]));
      const produced = kinds.lastIndexOf("genuine");
      assert.ok(produced >= 0, `No execution of ${name} in this run`);
      for (let index = produced + 1; index < entries.length; index++)
        assert.equal(kinds[index], "clone", `${name} is missing from attempt ${index + 1}`);
      for (const entry of entries.slice(produced)) {
        assert.equal(entry.job.status, "completed", `${name} has not completed`);
        assert.equal(entry.job.conclusion, "success", `${name} did not succeed`);
      }
      return { attempt: entries[produced].attempt, job: entries[produced].job };
    },
  };
}

// Shell steps compare a carried-over producer's recorded attempt with this.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { readGithub } = await import("./release-pr-checks.mjs");
  const [name] = process.argv.slice(2);
  const ledger = attemptLedger(
    { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    readGithub,
  );
  process.stdout.write(`${(await ledger.producer(name)).attempt}\n`);
}
