import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { proposalCommit } from "./proposal-git.mjs";
import { lockDigest } from "./proposal-tree.mjs";
import { proposalRequest, publishProposal } from "./proposal-publish.mjs";
import { releaseBotIdentity } from "../scripts/release-app-auth.mjs";
import { releasePreflight } from "../scripts/release-please-preflight.mjs";

const env = process.env;
const prepared = JSON.parse(await readFile(env.PREPARED_PROPOSAL, "utf8"));
assert.equal(prepared.schemaVersion, 1);
assert.equal(prepared.branch, env.TARGET_BRANCH);
assert.equal(prepared.base, env.TARGET_SHA);
assert.equal(env.GITHUB_REF, "refs/heads/dev");
assert.equal(env.GITHUB_REPOSITORY, "iExalt/paseo");
const identity = releaseBotIdentity(env);
const token = env.RELEASE_APP_TOKEN;
const request = proposalRequest(token);
const cwd = env.TARGET_DIRECTORY;
const files = new Map(prepared.files);
assert.equal(files.size, prepared.files.length, "Duplicate prepared paths");
assert.equal(lockDigest(files.get("package-lock.json")), prepared.lockSha256);
assert.equal(files.get("nix/npm-deps.hash"), `${prepared.npmDepsHash}\n`);
assert.deepEqual(
  await proposalCommit({ cwd, base: prepared.base, files, title: prepared.title, identity }),
  { sha: prepared.sha, tree: prepared.tree, base: prepared.base },
);
const validate = async () => {
  const preflight = await releasePreflight({
    repositoryPath: cwd,
    branch: prepared.branch,
    expectedSha: prepared.base,
    token,
  });
  assert.equal(preflight.ready, true);
  assert.equal(preflight.lastReleaseSha, prepared.lastReleaseSha, "Latest release changed");
};
const pr = await publishProposal({ prepared, identity, request, cwd, token, validate });
console.log(`Verified authentic proposal #${pr.number} at ${prepared.sha}`);
