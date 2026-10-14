import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { assertReleasePr } from "./release-pr.mjs";
import { validateSourceReceipt } from "./ci-source-receipt.mjs";
import { verifyStepProof } from "./step-proof.mjs";
import { retryingGhRead } from "./github-retry.mjs";

const repository = "/repos/iExalt/paseo";
export const readGithub = retryingGhRead((path, { text = false } = {}) => {
  const output = execFileSync("gh", ["api", path, "--allow-escape-sequences"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  return text ? output : JSON.parse(output);
});

async function pages(request, endpoint, field) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const result = await request(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(result[field]));
    rows.push(...result[field]);
    if (rows.length >= result.total_count) return rows;
    assert.ok(result[field].length, "Incomplete GitHub pagination");
  }
  throw new Error("GitHub proof exceeds bounded pagination");
}

export function latestPrRun(runs, workflow, pr, { merged = false } = {}) {
  // GitHub can erase the PR association after merge. Merged verification still
  // binds PR number, both SHAs and tested tree through the job's source receipt.
  // A run whose every job was skipped (e.g. an unrelated label) executed nothing,
  // so it never supersedes a proof; a newer failed or cancelled run still does.
  const matching = runs.filter(
    (run) =>
      run.conclusion !== "skipped" &&
      run.path === `.github/workflows/${workflow}` &&
      run.event === "pull_request" &&
      run.head_sha === pr.head.sha &&
      (merged || run.pull_requests?.some((item) => item.number === pr.number)),
  );
  matching.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
  assert.ok(matching.length, `Missing current-head ${workflow} run`);
  const run = matching[0];
  assert.equal(run.status, "completed", `${workflow} is not complete`);
  assert.equal(run.conclusion, "success", `${workflow} did not succeed`);
  return run;
}

export async function verifyCurrentPrChecks(number, identity, request = readGithub) {
  assert.ok(Number.isSafeInteger(number) && number > 0);
  const pr = await request(`${repository}/pulls/${number}`);
  assert.equal(pr.number, number);
  return verifyPrChecks(pr, identity, request, () => request(`${repository}/pulls/${number}`));
}

// The actual rebase commit preserves the verified premerge tree and parent even
// after dev advances. Its old PR base API field is not a source authority.
export async function verifyMergedPrChecks(number, sourceSha, identity, request = readGithub) {
  assert.ok(Number.isSafeInteger(number) && number > 0);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const merge = await request(`${repository}/git/commits/${sourceSha}`);
  assert.equal(merge.sha, sourceSha);
  assert.equal(merge.parents.length, 1, "Candidate requires a single rebase parent");
  const parent = merge.parents[0].sha;
  assert.match(parent, /^[a-f0-9]{40}$/);
  const readMerged = async () => {
    const pr = await request(`${repository}/pulls/${number}`);
    assert.equal(pr.number, number);
    assert.equal(pr.state, "closed");
    assert.equal(pr.merged, true);
    assert.equal(pr.merge_commit_sha, sourceSha);
    assert.equal(pr.base.ref, "dev");
    return { ...pr, state: "open", base: { ...pr.base, sha: parent } };
  };
  const proof = await verifyPrChecks(await readMerged(), identity, request, readMerged, {
    merged: true,
  });
  assert.equal(merge.tree.sha, proof.treeSha, "Merged candidate differs from tested PR tree");
  const dev = await request(`${repository}/git/ref/heads/dev`);
  assert.match(dev.object.sha, /^[a-f0-9]{40}$/);
  const ancestry = await request(`${repository}/compare/${sourceSha}...${dev.object.sha}`);
  assert.equal(ancestry.base_commit.sha, sourceSha);
  assert.ok(["ahead", "identical"].includes(ancestry.status), "Candidate is no longer in dev");
  assert.equal((await request(`${repository}/git/ref/heads/dev`)).object.sha, dev.object.sha);
  return { ...proof, sourceSha };
}

async function verifyPrChecks(pr, identity, request, readCurrent, options = {}) {
  const number = pr.number;
  assertReleasePr(pr, identity, pr.head.sha);
  assert.equal(pr.commits, 1, "Rehearsal requires one bot proposal commit");
  const commits = await request(`${repository}/pulls/${number}/commits?per_page=2`);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, pr.head.sha);
  const proofs = [];
  const runsFor = async (workflow) =>
    pages(
      request,
      `${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pr.head.sha}`,
      "workflow_runs",
    );
  for (const workflow of ["ci.yml", "ci-deep.yml"]) {
    const run = latestPrRun(await runsFor(workflow), workflow, pr, options);
    const jobs = await pages(
      request,
      `${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      "jobs",
    );
    const routine = workflow === "ci.yml";
    const names = routine
      ? ["plan", "Routine CI required"]
      : ["authorize-release", "deep (browser)", "deep (integration)", "deep (electron)"];
    const receipts = [];
    for (const name of names) {
      const matches = jobs.filter((job) => job.name === name);
      assert.equal(matches.length, 1, `Missing or ambiguous ${name} job`);
      const summary = matches[0];
      assert.equal(summary.status, "completed");
      assert.equal(summary.conclusion, "success");
      if (name === "Routine CI required" || name === "authorize-release") continue;
      // The signed proof replaces GitHub's step records and job logs as authority.
      const lane = routine ? null : name.match(/^deep \((browser|integration|electron)\)$/)[1];
      const proof = await verifyStepProof({
        runId: run.id,
        attempt: run.run_attempt,
        slot: routine ? "ci-source-routine" : `ci-source-deep-${lane}`,
        workflow,
        ref: `refs/pull/${number}/merge`,
      });
      const receipt = validateSourceReceipt(proof.evidence);
      assert.equal(receipt.repositoryId, 1404390841);
      assert.equal(receipt.runId, run.id);
      assert.equal(receipt.attempt, run.run_attempt);
      assert.equal(receipt.prNumber, number);
      assert.equal(receipt.baseSha, pr.base.sha);
      assert.equal(receipt.headSha, pr.head.sha);
      assert.match(receipt.sha, /^[a-f0-9]{40}$/);
      if (routine) {
        assert.equal(receipt.kind, "routine-pr");
        assert.equal(receipt.lane, null);
        assert.deepEqual(receipt.parents, [pr.base.sha, pr.head.sha]);
        assert.equal(proof.sourceSha, receipt.sha, "Routine proof signed another checkout");
      } else {
        assert.equal(receipt.kind, "deep");
        assert.equal(receipt.sha, pr.head.sha);
        assert.equal(name, `deep (${receipt.lane})`);
        // The signer's own checkout is the one claim its code cannot choose.
        const signed = await request(`${repository}/git/commits/${proof.sourceSha}`);
        assert.equal(signed.sha, proof.sourceSha);
        assert.deepEqual(
          signed.parents.map((parent) => parent.sha),
          [pr.base.sha, pr.head.sha],
          "Deep proof signed another checkout",
        );
      }
      receipts.push(receipt);
    }
    proofs.push({ workflow, runId: run.id, attempt: run.run_attempt, receipts });
  }
  const tested = proofs.find((proof) => proof.workflow === "ci.yml").receipts[0];
  const testedCommit = await request(`${repository}/git/commits/${tested.sha}`);
  assert.equal(testedCommit.sha, tested.sha);
  assert.deepEqual(
    testedCommit.parents.map((parent) => parent.sha),
    [pr.base.sha, pr.head.sha],
  );
  assert.match(testedCommit.tree.sha, /^[a-f0-9]{40}$/);
  // Recheck both axes after logs/API enumeration; old green never blesses movement.
  for (const proof of proofs) {
    const latest = latestPrRun(await runsFor(proof.workflow), proof.workflow, pr, options);
    assert.equal(latest.id, proof.runId, "A newer run superseded the proof");
    assert.equal(latest.run_attempt, proof.attempt, "A rerun superseded the proof");
  }
  const current = await readCurrent();
  assertReleasePr(current, identity, pr.head.sha);
  assert.equal(current.commits, 1);
  assert.equal(current.base.sha, pr.base.sha, "PR base moved during verification");
  return {
    number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    treeSha: testedCommit.tree.sha,
    proofs,
  };
}

export function verifyRehearsalMerge(pr, commit, proof, { returnedSha, branchSha }) {
  assert.equal(pr.base.ref, "ci/release-please-rehearsal");
  assert.equal(pr.number, proof.number);
  assert.equal(pr.merged, true);
  assert.equal(pr.state, "closed");
  assert.equal(pr.head.sha, proof.headSha);
  assert.equal(pr.commits, 1);
  assert.equal(commit.sha, pr.merge_commit_sha);
  assert.equal(commit.sha, returnedSha);
  assert.equal(commit.sha, branchSha);
  assert.deepEqual(
    commit.parents.map((parent) => parent.sha),
    [proof.baseSha],
  );
  assert.equal(commit.tree.sha, proof.treeSha, "Rebased merge differs from the tested merge tree");
  return commit.sha;
}
