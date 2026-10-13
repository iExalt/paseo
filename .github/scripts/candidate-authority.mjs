import assert from "node:assert/strict";
import { assertReleasePr } from "./release-pr.mjs";
import { verifyMergedPrChecks } from "./release-pr-checks.mjs";
import { inspectForkRelease, validateForkConfig } from "../../scripts/fork-release-config.mjs";
import {
  descriptorFromProof,
  sourceGatePolicy,
  validateDescriptor,
} from "./candidate-descriptor.mjs";

import { replacementForSource, verifyReplacementHistory } from "./candidate-replacement.mjs";
import { validateGrant } from "./candidate-grant.mjs";

const repo = "/repos/iExalt/paseo";
async function sourceVersion(sourceSha, read) {
  const { config } = await inspectForkRelease((file) => read(sourceSha, file));
  const manifest = JSON.parse(await read(sourceSha, ".release-please-manifest.json"));
  assert.deepEqual(
    manifest,
    { ".": config.version },
    "Merged version proposal manifest differs from source",
  );
  return config;
}
export function candidateRoute(event, env) {
  assert.equal(event.repository.id, 1404390841);
  assert.equal(event.repository.full_name, "iExalt/paseo");
  assert.equal(event.repository.private, false);
  assert.equal(env.GITHUB_REF, "refs/heads/dev");
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    assert.equal(event.action, "closed");
    assert.equal(event.pull_request.merged, true);
    assert.equal(event.pull_request.base.ref, "dev");
    assert.ok(Number.isSafeInteger(event.pull_request.number) && event.pull_request.number > 0);
    assert.match(event.pull_request.merge_commit_sha, /^[a-f0-9]{40}$/);
    return { number: event.pull_request.number, sourceSha: event.pull_request.merge_commit_sha };
  }
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_ACTOR, "iExalt");
  assert.equal(event.sender.id, 7889894);
  const releaseId = event.inputs?.release_id ?? "";
  const number = event.inputs?.merged_pr ?? "";
  assert.notEqual(Boolean(releaseId), Boolean(number), "Specify exactly one draft ID or merged PR");
  const value = releaseId || number;
  assert.match(value, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(Number(value)));
  return releaseId ? { releaseId: Number(value) } : { number: Number(value) };
}

export async function newCandidate(route, controllerSha, identity, request, read) {
  if (!route.sourceSha) {
    const pr = await request(`${repo}/pulls/${route.number}`);
    assert.equal(pr.number, route.number);
    assert.equal(pr.state, "closed");
    assert.equal(pr.merged, true);
    route = { ...route, sourceSha: pr.merge_commit_sha };
  }
  const proof = await verifyMergedPrChecks(route.number, route.sourceSha, identity, request);
  const fork = await sourceVersion(route.sourceSha, read);
  const policy = await sourceGatePolicy(controllerSha, (file) => read(controllerSha, file));
  return descriptorFromProof(proof, fork, policy);
}

// Signed authority is durable, but it never exempts a retry from present source,
// lineage, policy or lifecycle eligibility. No expired job logs are required here.
async function currentIdentity(descriptor, controllerSha, identity, request, read) {
  validateDescriptor(descriptor);
  const issuedPolicy = await sourceGatePolicy(descriptor.policy.sourceSha, (file) =>
    read(descriptor.policy.sourceSha, file),
  );
  const trustedPolicy = await sourceGatePolicy(controllerSha, (file) => read(controllerSha, file));
  assert.deepEqual(issuedPolicy, descriptor.policy, "Issuing policy bytes changed");
  assert.equal(issuedPolicy.version, trustedPolicy.version);
  assert.equal(
    issuedPolicy.sha256,
    trustedPolicy.sha256,
    "Policy changed; explicit candidate reauthorization required",
  );
  const fork = await sourceVersion(descriptor.sourceSha, read);
  assert.equal(fork.version, descriptor.version);
  assert.equal(fork.upstreamBase, descriptor.upstreamBase);
  const checkPr = async () => {
    const pr = await request(`${repo}/pulls/${descriptor.releasePr}`);
    assert.equal(pr.number, descriptor.releasePr);
    assert.equal(pr.state, "closed");
    assert.equal(pr.merged, true);
    assert.equal(pr.merge_commit_sha, descriptor.sourceSha);
    assert.equal(pr.base.ref, "dev");
    assert.equal(pr.commits, 1);
    assertReleasePr({ ...pr, state: "open" }, identity, descriptor.headSha);
  };
  await checkPr();
  const commit = await request(`${repo}/git/commits/${descriptor.sourceSha}`);
  assert.equal(commit.sha, descriptor.sourceSha);
  assert.equal(commit.tree.sha, descriptor.treeSha);
  assert.deepEqual(
    commit.parents.map((parent) => parent.sha),
    [descriptor.baseSha],
  );
  const dev = await request(`${repo}/git/ref/heads/dev`);
  assert.match(dev.object.sha, /^[a-f0-9]{40}$/);
  const ancestry = await request(`${repo}/compare/${descriptor.sourceSha}...${dev.object.sha}`);
  assert.equal(ancestry.base_commit.sha, descriptor.sourceSha);
  assert.ok(["ahead", "identical"].includes(ancestry.status));
  const currentFork = validateForkConfig(
    JSON.parse(await read(dev.object.sha, ".github/fork-release.json")),
  );
  assert.equal(
    currentFork.version,
    descriptor.version,
    "Another version superseded this candidate",
  );
  await checkPr();
  assert.equal((await request(`${repo}/git/ref/heads/dev`)).object.sha, dev.object.sha);
  return descriptor;
}

export async function currentCandidate(descriptor, controllerSha, identity, request, read, api) {
  await currentIdentity(descriptor, controllerSha, identity, request, read);
  const record = await replacementForSource(descriptor, read, request);
  if (record) {
    assert.ok(api, "Trusted replacement history verification requires draft access");
    await verifyReplacementHistory(record, {
      api,
      request,
      identity,
      currentSource: descriptor.sourceSha,
    });
  }
  return descriptor;
}

export async function currentGrantedCandidate(
  descriptor,
  controllerSha,
  identity,
  request,
  read,
  proof,
) {
  await validateGrant(
    proof.grant,
    proof.context,
    proof.group,
    proof.worker,
    proof.jobs,
    proof.pin,
    proof.artifact,
  );
  assert.deepEqual(proof.context.descriptor, descriptor);
  assert.equal(proof.context.controllerSha, controllerSha);
  await currentIdentity(descriptor, controllerSha, identity, request, read);
  await replacementForSource(descriptor, read, request);
  return descriptor;
}
