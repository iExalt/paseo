import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateGithub } from "./candidate-github.mjs";
import { loadDescriptor, requireAttempt, requireCurrentRun } from "./candidate-draft.mjs";
import { currentCandidate } from "./candidate-authority.mjs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { releaseBotIdentity } from "./release-app-auth.mjs";
import { readGithub } from "./release-pr-checks.mjs";

export async function workerGate(env, api, request, read, grant = null) {
  const releaseId = Number(env.CANDIDATE_RELEASE_ID);
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  assert.equal(env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(env.GITHUB_REF, "refs/heads/dev");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev",
  );
  const descriptor = grant ? grant.context.descriptor : await loadDescriptor(api, releaseId);
  assert.equal(
    descriptor.sourceSha,
    env.PASEO_CANDIDATE_SHA,
    "Caller supplied another candidate source",
  );
  assert.equal(descriptorDigest(descriptor), env.CANDIDATE_DESCRIPTOR_DIGEST);
  await currentCandidate(descriptor, env.GITHUB_SHA, releaseBotIdentity(env), request, read);
  const runId = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const { headBranch: rootBranch, headSha: rootHeadSha } = await requireCurrentRun(
    env,
    request,
    descriptor,
  );
  const context = {
    descriptor,
    releaseId,
    runId,
    attempt,
    controllerSha: env.GITHUB_SHA,
    rootBranch,
    rootHeadSha,
  };
  if (grant) {
    const { validateGrant } = await import("./candidate-grant.mjs");
    validateGrant(
      grant,
      context,
      env.CANDIDATE_GRANT_GROUP,
      env.CANDIDATE_EXPECTED_JOB,
      await attemptJobs(context, request),
      api.publicPin,
    );
  } else await requireAttempt(api, descriptor, releaseId, runId, attempt);
  return context;
}

export async function readTrustedWorkerContext(env = process.env) {
  assert.ok(!env.CANDIDATE_GRANT_ID, "Trusted admission cannot use a worker grant");
  return readContext(env, false);
}

export async function readWorkerContext(env = process.env) {
  assert.ok(env.CANDIDATE_GRANT_ID, "Execution requires a controller-issued worker grant");
  return readContext(env, true);
}

async function readContext(env, granted) {
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.GITHUB_SHA,
  );
  const grant = granted ? await (await import("./candidate-grant.mjs")).downloadGrant(env) : null;
  return workerGate(
    env,
    candidateGithub(env.GH_TOKEN),
    readGithub,
    async (sha, file) => {
      assert.match(sha, /^[a-f0-9]{40}$/);
      assert.match(file, /^[a-zA-Z0-9._/-]+$/);
      return execFileSync("git", ["show", `${sha}:${file}`], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30000,
      });
    },
    grant,
  );
}

export async function attemptJobs(context, request = readGithub) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await request(
      `/repos/iExalt/paseo/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(result.jobs));
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
  throw new Error("Candidate job inventory exceeds bound");
}

export function verifyWorkerJob(context, jobs, expected) {
  assert.ok(typeof expected === "string" && expected.length > 0);
  const matches = jobs.filter((job) => job.name === expected);
  assert.equal(matches.length, 1, `Missing or duplicate active worker ${expected}`);
  assert.equal(matches[0].run_id, context.runId);
  assert.equal(matches[0].run_attempt, context.attempt);
  assert.equal(matches[0].status, "in_progress");
  assert.equal(matches[0].conclusion, null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  assert.ok(env.CANDIDATE_GRANT_ID, "Execution requires a controller-issued worker grant");
  const context = await readWorkerContext(env);
  verifyWorkerJob(context, await attemptJobs(context), env.CANDIDATE_EXPECTED_JOB);
  const file = join(env.RUNNER_TEMP, `paseo-candidate-${context.runId}-${context.attempt}.json`);
  await writeFile(file, JSON.stringify(context) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await appendFile(
    env.GITHUB_OUTPUT,
    `source_sha=${context.descriptor.sourceSha}\ntree_sha=${context.descriptor.treeSha}\nversion=${context.descriptor.version}\ncontext=${file}\n`,
  );
  await appendFile(env.GITHUB_ENV, `PASEO_CANDIDATE_CONTEXT=${file}\n`);
}
