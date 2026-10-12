import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHub, Manifest } from "release-please";
import {
  composeProposalTree,
  lockDigest,
  validateNpmHash,
  verifyProposalLock,
} from "./proposal-tree.mjs";
import { proposalCommit, proposalRef } from "./proposal-git.mjs";
import { proposalRequest } from "./proposal-publish.mjs";
import { releaseBotIdentity } from "../scripts/release-app-auth.mjs";
import { assertReleasePr } from "../scripts/release-pr.mjs";
import { replacementTree } from "../scripts/candidate-replacement.mjs";

export async function prefetchProposalLock(lock) {
  const pin = JSON.parse(await readFile(new URL("../../flake.lock", import.meta.url), "utf8")).nodes
    .nixpkgs.locked;
  assert.equal(pin.type, "github");
  for (const key of ["owner", "repo"]) assert.match(pin[key], /^[a-zA-Z0-9_-]+$/);
  assert.match(pin.rev, /^[a-f0-9]{40}$/);
  const directory = await mkdtemp(join(tmpdir(), "paseo-proposal-lock-"));
  const started = Date.now();
  try {
    const file = join(directory, "package-lock.json");
    await writeFile(file, lock);
    const hash = execFileSync(
      "nix",
      [
        "shell",
        `github:${pin.owner}/${pin.repo}/${pin.rev}#prefetch-npm-deps`,
        "-c",
        "prefetch-npm-deps",
        file,
      ],
      {
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ).trim();
    assert.equal(await readFile(file, "utf8"), lock, "Fetcher changed the lock");
    return validateNpmHash(hash);
  } finally {
    console.log(`Proposal dependency hash preparation: ${Date.now() - started}ms`);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareProposal({
  cwd,
  branch,
  base,
  token,
  identity,
  replacement,
  request = proposalRequest(token),
  prefetch = prefetchProposalLock,
}) {
  const repository = "/repos/iExalt/paseo";
  const ref = proposalRef(branch).slice("refs/heads/".length);
  const currentBase = async () =>
    assert.equal(
      (await request(`${repository}/git/ref/heads/${branch}`)).object.sha,
      base,
      "Target changed while preparing",
    );
  await currentBase();
  const expectedHead = (await request(`${repository}/git/ref/heads/${ref}`))?.object.sha ?? "";
  const read = async (file) => readFile(resolve(cwd, file), "utf8");
  let materialized, title, body, previousPr;
  if (replacement) {
    assert.equal(branch, "dev");
    assert.equal(replacement.repairBase, base);
    materialized = { files: await replacementTree(replacement, read) };
    assert.equal(await prefetch(await read("package-lock.json")), replacement.npmDepsHash);
    title = `chore(dev): replace pending release ${replacement.version}`;
    body = `Replace unpublished version ${replacement.version} from PR #${replacement.supersededPr} with the repaired source at ${base}.\n\nThe selection record preserves publication history and binds the stopped signed predecessor authorities. Fresh routine, deep and complete native verification are required before publication.`;
    previousPr = replacement.supersededPr;
  } else {
    const github = await GitHub.create({
      owner: "iExalt",
      repo: "paseo",
      defaultBranch: branch,
      token,
    });
    const manifest = await Manifest.fromManifest(github, branch);
    const proposals = await manifest.buildPullRequests();
    if (!proposals.length) {
      await currentBase();
      return null;
    }
    assert.equal(proposals.length, 1);
    const proposal = proposals[0];
    assert.equal(proposal.headRefName, ref);
    materialized = await composeProposalTree(proposal, read, prefetch);
    verifyProposalLock(materialized);
    title = `chore(dev): release ${proposal.version.toString()}`;
    body = proposal.body.toString();
    if (expectedHead) {
      const rows = await request(
        `${repository}/pulls?state=all&head=iExalt:${encodeURIComponent(ref)}&base=${encodeURIComponent(branch)}&per_page=100`,
      );
      assert.ok(Array.isArray(rows) && rows.length < 100, "Proposal history exceeds bound");
      const matching = rows.filter((row) => row.head.sha === expectedHead);
      assert.equal(matching.length, 1, "Existing branch requires one authentic proposal");
      const prior = await request(`${repository}/pulls/${matching[0].number}`);
      assertReleasePr(
        { ...prior, state: "open", labels: [{ name: "autorelease: pending" }] },
        identity,
        expectedHead,
      );
      if (prior.state === "open")
        assert.ok(prior.labels.some((label) => label.name === "autorelease: pending"));
      else {
        assert.equal(prior.state, "closed");
        assert.equal(prior.merged, true);
        const boundary = JSON.parse(await read(".github/release-boundary.json"));
        assert.equal(boundary.kind, "release");
        assert.equal(prior.merge_commit_sha, boundary.originalSha);
      }
      previousPr = prior.number;
    }
  }
  const commit = await proposalCommit({ cwd, base, files: materialized.files, title, identity });
  await currentBase();
  assert.equal(
    (await request(`${repository}/git/ref/heads/${ref}`))?.object.sha ?? "",
    expectedHead,
    "Proposal changed during preparation",
  );
  return {
    schemaVersion: 1,
    branch,
    ...commit,
    expectedHead,
    title,
    body,
    previousPr,
    replacement,
    files: [...materialized.files],
    lockSha256: materialized.lockSha256 ?? lockDigest(await read("package-lock.json")),
    npmDepsHash: materialized.npmDepsHash ?? replacement.npmDepsHash,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const replacement = process.env.REPLACEMENT_RECORD
    ? JSON.parse(process.env.REPLACEMENT_RECORD)
    : undefined;
  const result = await prepareProposal({
    cwd: process.env.TARGET_DIRECTORY,
    branch: process.env.TARGET_BRANCH,
    base: process.env.TARGET_SHA,
    token: process.env.GITHUB_TOKEN,
    identity: releaseBotIdentity(process.env),
    replacement,
  });
  if (result)
    await writeFile(process.env.PREPARED_PROPOSAL, `${JSON.stringify(result)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  await appendFile(process.env.GITHUB_OUTPUT, `ready=${Boolean(result)}\n`);
}
