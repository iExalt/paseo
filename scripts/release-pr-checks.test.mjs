import assert from "node:assert/strict";
import test from "node:test";
import {
  RECEIPT_PREFIX,
  sourceReceipt,
  readSourceReceipt,
} from "../.github/scripts/ci-source-receipt.mjs";
import {
  latestPrRun,
  verifyCurrentPrChecks,
  verifyRehearsalMerge,
} from "../.github/scripts/release-pr-checks.mjs";

const head = "a".repeat(40),
  base = "b".repeat(40),
  merge = "c".repeat(40);
const identity = { botId: 456, botLogin: "paseo-release[bot]" };
const repo = { id: 1404390841, full_name: "iExalt/paseo", private: false };
const pr = {
  number: 7,
  state: "open",
  user: { id: 456, login: identity.botLogin, type: "Bot" },
  base: { repo, ref: "ci/release-please-rehearsal", sha: base },
  head: {
    repo,
    ref: "release-please--branches--ci/release-please-rehearsal--components--paseo",
    sha: head,
  },
  labels: [{ name: "autorelease: pending" }],
};
const env = {
  GITHUB_REPOSITORY_ID: "1404390841",
  GITHUB_RUN_ID: "100",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "pull_request",
  PR_NUMBER: "7",
  PR_BASE_SHA: base,
  PR_HEAD_SHA: head,
};
const step = {
  status: "completed",
  conclusion: "success",
  started_at: "2026-10-12T00:00:00Z",
  completed_at: "2026-10-12T00:00:01Z",
};
const line = (receipt) => `2026-10-12T00:00:00.123Z ${RECEIPT_PREFIX}${JSON.stringify(receipt)}\n`;

test("checkout receipts distinguish merge verification from exact-head deep and push checks", () => {
  const git = (...args) => (args[0] === "rev-parse" ? merge : `${base} ${head}`);
  const receipt = sourceReceipt(env, git);
  assert.equal(receipt.kind, "routine-pr");
  assert.deepEqual(readSourceReceipt(line(receipt), step), receipt);
  assert.throws(() => sourceReceipt({ ...env, PR_BASE_SHA: head }, git), /captured base/);
  const deep = sourceReceipt({ ...env, DEEP_LANE: "browser", SOURCE_SHA: head }, (...args) =>
    args[0] === "rev-parse" ? head : base,
  );
  assert.equal(deep.sha, head);
  assert.throws(
    () => sourceReceipt({ ...env, DEEP_LANE: "browser", SOURCE_SHA: head }, git),
    /authorized head/,
  );
  assert.equal(
    sourceReceipt(
      {
        ...env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_SHA: merge,
        PR_NUMBER: "",
        PR_BASE_SHA: "",
        PR_HEAD_SHA: "",
      },
      git,
    ).kind,
    "routine-push",
  );
  for (const log of [
    "",
    line(receipt) + line(receipt),
    `test output ${line(receipt)}`,
    line(receipt).replace("00:00:00.123", "00:00:09.123"),
  ])
    assert.throws(() => readSourceReceipt(log, step));
  assert.throws(() => readSourceReceipt(line(receipt), { ...step, conclusion: "failure" }));
});

function fixture() {
  const runs = ["ci.yml", "ci-deep.yml"].map((workflow, index) => ({
    id: 100 + index,
    run_attempt: 1,
    path: `.github/workflows/${workflow}`,
    event: "pull_request",
    head_sha: head,
    pull_requests: [{ number: 7 }],
    status: "completed",
    conclusion: "success",
  }));
  const jobNames = [
    ["plan", "Routine CI required"],
    ["authorize-release", "deep (browser)", "deep (integration)", "deep (electron)"],
  ];
  const jobs = jobNames.map((names, index) =>
    names.map((name, i) => ({
      id: 200 + index * 10 + i,
      name,
      status: "completed",
      conclusion: "success",
      steps: [
        {
          ...step,
          name: index
            ? "Validate exact source and isolated configuration"
            : "Plan checks and record source",
        },
      ],
    })),
  );
  const logs = new Map();
  for (let index = 0; index < jobs.length; index++)
    for (const job of jobs[index]) {
      if (job.name === "Routine CI required" || job.name === "authorize-release") continue;
      const lane = index ? job.name.slice(6, -1) : "";
      const receipt = sourceReceipt(
        { ...env, GITHUB_RUN_ID: String(100 + index), DEEP_LANE: lane, SOURCE_SHA: head },
        (...args) => {
          if (args[0] === "rev-parse") return index ? head : merge;
          return index ? base : `${base} ${head}`;
        },
      );
      logs.set(job.id, line(receipt));
    }
  let prReads = 0;
  const state = { runs, jobs, logs, current: structuredClone(pr), onFinal: () => {} };
  state.request = async (url) => {
    if (url.endsWith("/pulls/7")) {
      if (++prReads === 2) state.onFinal(state.current);
      return structuredClone(state.current);
    }
    if (url.includes("/workflows/"))
      return { total_count: 1, workflow_runs: [runs[url.includes("ci-deep.yml") ? 1 : 0]] };
    if (url.includes("/attempts/"))
      return {
        total_count: jobs[url.includes("/101/") ? 1 : 0].length,
        jobs: jobs[url.includes("/101/") ? 1 : 0],
      };
    if (url.endsWith("/logs")) return logs.get(Number(url.split("/").at(-2)));
    throw new Error(`Unexpected request ${url}`);
  };
  return state;
}

test("current-head verifier requires both latest gates, exact setup receipts and unchanged PR", async () => {
  const good = fixture();
  const proof = await verifyCurrentPrChecks(7, identity, good.request);
  assert.equal(proof.headSha, head);
  assert.equal(proof.proofs.length, 2);
  for (const mutate of [
    (f) => {
      f.runs[0].status = "in_progress";
    },
    (f) => {
      f.runs[1].conclusion = "cancelled";
    },
    (f) => {
      f.runs[0].head_sha = base;
    },
    (f) => {
      f.jobs[1][0].conclusion = "failure";
    },
    (f) => {
      f.jobs[1].pop();
    },
    (f) => {
      f.logs.set(200, "");
    },
    (f) => {
      f.logs.set(200, f.logs.get(200).replace(`"baseSha":"${base}"`, `"baseSha":"${head}"`));
    },
    (f) => {
      const original = f.request;
      let reads = 0;
      f.request = async (...args) => {
        if (args[0].includes("/workflows/ci.yml/") && ++reads === 2) f.runs[0].run_attempt = 2;
        return original(...args);
      };
    },
    (f) => {
      f.onFinal = (p) => {
        p.head.sha = merge;
      };
    },
    (f) => {
      f.onFinal = (p) => {
        p.base.sha = merge;
      };
    },
  ]) {
    const broken = fixture();
    mutate(broken);
    await assert.rejects(verifyCurrentPrChecks(7, identity, broken.request));
  }
  assert.throws(() =>
    latestPrRun(
      [good.runs[0], { ...good.runs[0], id: 102, status: "queued", conclusion: null }],
      "ci.yml",
      pr,
    ),
  );
  const merged = { ...pr, state: "closed", merged: true, merge_commit_sha: merge };
  assert.equal(
    verifyRehearsalMerge(merged, { sha: merge, parents: [{ sha: base }, { sha: head }] }, proof),
    merge,
  );
  assert.throws(() =>
    verifyRehearsalMerge(merged, { sha: head, parents: [{ sha: base }, { sha: head }] }, proof),
  );
  assert.throws(() =>
    verifyRehearsalMerge(merged, { sha: merge, parents: [{ sha: head }, { sha: base }] }, proof),
  );
  assert.throws(() =>
    verifyRehearsalMerge(
      { ...merged, base: { ...pr.base, ref: "dev" } },
      { sha: merge, parents: [{ sha: base }, { sha: head }] },
      proof,
    ),
  );
});
