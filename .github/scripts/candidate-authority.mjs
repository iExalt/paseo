import assert from "node:assert/strict";
import { assertReleasePr } from "./release-pr.mjs";
import { verifyMergedPrChecks } from "./release-pr-checks.mjs";
import { validateForkConfig } from "../../scripts/fork-release-config.mjs";
import {
  descriptorFromProof,
  sourceGatePolicy,
  validateDescriptor,
} from "./candidate-descriptor.mjs";

const repo = "/repos/iExalt/paseo";
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
  assert.match(event.inputs?.release_id ?? "", /^[1-9][0-9]*$/);
  const releaseId = Number(event.inputs.release_id);
  assert.ok(Number.isSafeInteger(releaseId));
  return { releaseId };
}

export async function newCandidate(route, controllerSha, identity, request, read) {
  const proof = await verifyMergedPrChecks(route.number, route.sourceSha, identity, request);
  const fork = validateForkConfig(
    JSON.parse(await read(route.sourceSha, ".github/fork-release.json")),
  );
  const policy = await sourceGatePolicy(controllerSha, (file) => read(controllerSha, file));
  return descriptorFromProof(proof, fork, policy);
}

// Signed authority is durable, but it never exempts a retry from present source,
// lineage, policy or lifecycle eligibility. No expired job logs are required here.
export async function currentCandidate(descriptor, controllerSha, identity, request, read) {
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
  const fork = validateForkConfig(
    JSON.parse(await read(descriptor.sourceSha, ".github/fork-release.json")),
  );
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
