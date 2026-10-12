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

export async function workerGate(env, api, request, read) {
  const releaseId = Number(env.CANDIDATE_RELEASE_ID);
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  assert.equal(env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(env.GITHUB_REF, "refs/heads/dev");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev",
  );
  const descriptor = await loadDescriptor(api, releaseId);
  assert.equal(
    descriptor.sourceSha,
    env.PASEO_CANDIDATE_SHA,
    "Caller supplied another candidate source",
  );
  assert.equal(descriptorDigest(descriptor), env.CANDIDATE_DESCRIPTOR_DIGEST);
  await currentCandidate(descriptor, env.GITHUB_SHA, releaseBotIdentity(env), request, read);
  const runId = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  return {
    descriptor,
    releaseId,
    runId,
    attempt,
    controllerSha: env.GITHUB_SHA,
  };
}

export async function readWorkerContext(env = process.env) {
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.GITHUB_SHA,
  );
  return workerGate(env, candidateGithub(env.GH_TOKEN), readGithub, async (sha, file) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert.match(file, /^[a-zA-Z0-9._/-]+$/);
    return execFileSync("git", ["show", `${sha}:${file}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
    });
  });
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  const context = await readWorkerContext(env);
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
