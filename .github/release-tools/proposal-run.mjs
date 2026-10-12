import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { proposalCommit } from "./proposal-git.mjs";
import { lockDigest } from "./proposal-tree.mjs";
import { proposalRequest, publishProposal } from "./proposal-publish.mjs";
import { releaseBotIdentity } from "../scripts/release-app-auth.mjs";
import { releasePreflight } from "../scripts/release-please-preflight.mjs";
import { candidateGithub } from "../scripts/candidate-github.mjs";
import { verifyReplacementHistory, replacementTree } from "../scripts/candidate-replacement.mjs";

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
const read = async (file) =>
  execFileSync("git", ["show", `${prepared.base}:${file}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
const files = new Map(prepared.files);
assert.equal(files.size, prepared.files.length, "Duplicate prepared paths");
if (prepared.replacement) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_ACTOR, "iExalt");
  assert.deepEqual(prepared.replacement, JSON.parse(env.REPLACEMENT_RECORD));
  assert.deepEqual(files, await replacementTree(prepared.replacement, read));
} else {
  assert.equal(env.REPLACEMENT_RECORD ?? "", "");
  assert.equal(lockDigest(files.get("package-lock.json")), prepared.lockSha256);
  assert.equal(files.get("nix/npm-deps.hash"), `${prepared.npmDepsHash}\n`);
}
assert.deepEqual(
  await proposalCommit({ cwd, base: prepared.base, files, title: prepared.title, identity }),
  { sha: prepared.sha, tree: prepared.tree, base: prepared.base },
);
const api = candidateGithub(token);
const validate = async () => {
  const preflight = await releasePreflight({
    repositoryPath: cwd,
    branch: prepared.branch,
    expectedSha: prepared.base,
    token,
    replacement: prepared.replacement,
  });
  assert.equal(preflight.ready, true);
  if (prepared.replacement)
    await verifyReplacementHistory(prepared.replacement, { api, request, identity });
};
const pr = await publishProposal({ prepared, identity, request, cwd, token, validate });
console.log(`Verified authentic proposal #${pr.number} at ${prepared.sha}`);
