import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Coordinator mode depends on the workflow's signed worker gate preceding
// candidate checkout. This checks that gate's context, not just a source input.
export function assertNativeActor(env, read = readFileSync) {
  if (
    env.GITHUB_WORKFLOW_REF ===
    "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev"
  ) {
    assert.match(env.PASEO_CANDIDATE_SHA, /^[a-f0-9]{40}$/);
    assert.match(env.GITHUB_RUN_ID, /^[1-9]\d*$/);
    assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9]\d*$/);
    const file = join(
      env.RUNNER_TEMP,
      `paseo-candidate-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`,
    );
    assert.equal(env.PASEO_CANDIDATE_CONTEXT, file);
    const context = JSON.parse(read(file, "utf8"));
    assert.equal(context.descriptor.sourceSha, env.PASEO_CANDIDATE_SHA);
    assert.equal(context.controllerSha, env.GITHUB_SHA);
    assert.equal(context.runId, Number(env.GITHUB_RUN_ID));
    assert.equal(context.attempt, Number(env.GITHUB_RUN_ATTEMPT));
  } else assert.equal(env.GITHUB_ACTOR, "iExalt");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  assertNativeActor(process.env);
