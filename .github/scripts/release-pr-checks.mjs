import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { assertReleasePr } from "./release-pr.mjs";
import { readSourceReceipt } from "./ci-source-receipt.mjs";

const repository = "/repos/iExalt/paseo";
export function readGithub(path, { text = false } = {}) {
  const output = execFileSync("gh", ["api", path, "--allow-escape-sequences"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  return text ? output : JSON.parse(output);
}

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

export function latestPrRun(runs, workflow, pr) {
  const matching = runs.filter(
    (run) =>
      run.path === `.github/workflows/${workflow}` &&
      run.event === "pull_request" &&
      run.head_sha === pr.head.sha &&
      run.pull_requests?.some((item) => item.number === pr.number),
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
    const run = latestPrRun(await runsFor(workflow), workflow, pr);
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
      const job = matches[0];
      assert.equal(job.status, "completed");
      assert.equal(job.conclusion, "success");
      if (name === "Routine CI required" || name === "authorize-release") continue;
      const stepName = routine
        ? "Plan checks and record source"
        : "Validate exact source and isolated configuration";
      const steps = job.steps.filter((step) => step.name === stepName);
      assert.equal(steps.length, 1);
      const receipt = readSourceReceipt(
        await request(`${repository}/actions/jobs/${job.id}/logs`, { text: true }),
        steps[0],
      );
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
      } else {
        assert.equal(receipt.kind, "deep");
        assert.equal(receipt.sha, pr.head.sha);
        assert.equal(name, `deep (${receipt.lane})`);
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
    const latest = latestPrRun(await runsFor(proof.workflow), proof.workflow, pr);
    assert.equal(latest.id, proof.runId, "A newer run superseded the proof");
    assert.equal(latest.run_attempt, proof.attempt, "A rerun superseded the proof");
  }
  const current = await request(`${repository}/pulls/${number}`);
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
