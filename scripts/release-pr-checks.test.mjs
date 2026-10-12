import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { candidateEntry } from "../.github/scripts/candidate-entry.mjs";
import { currentCandidate, candidateRoute } from "../.github/scripts/candidate-authority.mjs";
import { descriptorDigest } from "../.github/scripts/candidate-descriptor.mjs";
import {
  RECEIPT_PREFIX,
  sourceReceipt,
  readSourceReceipt,
} from "../.github/scripts/ci-source-receipt.mjs";
import {
  latestPrRun,
  verifyCurrentPrChecks,
  verifyMergedPrChecks,
  verifyRehearsalMerge,
} from "../.github/scripts/release-pr-checks.mjs";

const head = "a".repeat(40),
  base = "b".repeat(40),
  merge = "c".repeat(40);
const identity = { botId: 456, botLogin: "paseo-release[bot]" };
const repo = { id: 1404390841, full_name: "iExalt/paseo", private: false };
const pr = {
  commits: 1,
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
    if (url.includes("/pulls/7/commits?")) return [{ sha: state.current.head.sha }];
    if (url.includes("/git/commits/"))
      return { sha: merge, parents: [{ sha: base }, { sha: head }], tree: { sha: "d".repeat(40) } };
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

test("merged authority binds the old checked tree and parent while dev advances", async () => {
  const source = "e".repeat(40),
    dev = "f".repeat(40);
  const setup = () => {
    const f = fixture();
    Object.assign(f.current, { state: "closed", merged: true, merge_commit_sha: source });
    f.current.base = { ...f.current.base, ref: "dev", sha: dev };
    f.current.head.ref = "release-please--branches--dev--components--paseo";
    f.commit = { sha: source, parents: [{ sha: base }], tree: { sha: "d".repeat(40) } };
    f.ancestry = { status: "ahead", base_commit: { sha: source } };
    const request = f.request;
    f.request = async (url) => {
      if (url.endsWith(`/git/commits/${source}`)) return f.commit;
      if (url.endsWith("/git/ref/heads/dev")) return { object: { sha: dev } };
      if (url.includes("/compare/")) return f.ancestry;
      return request(url);
    };
    return f;
  };
  const proof = await verifyMergedPrChecks(7, source, identity, setup().request);
  assert.equal(proof.sourceSha, source);
  assert.equal(proof.baseSha, base);
  const fork = {
    schemaVersion: 1,
    repository: repo.full_name,
    lineage: "iExalt/paseo:semver-v1",
    version: "0.1.0",
    upstreamBase: base,
  };
  const rootPackage = { name: "paseo", version: fork.version, private: true, workspaces: [] };
  const sourceFiles = {
    ".github/fork-release.json": JSON.stringify(fork),
    ".release-please-manifest.json": JSON.stringify({ ".": fork.version }),
    "package.json": JSON.stringify(rootPackage),
    "package-lock.json": JSON.stringify({ version: fork.version, packages: { "": rootPackage } }),
    "CHANGELOG.fork.md": "# Fork release",
  };
  const read = async (_sha, file) => sourceFiles[file] ?? "trusted policy fixture";
  const entryEnv = {
    GITHUB_REF: "refs/heads/dev",
    GITHUB_SHA: dev,
    GITHUB_EVENT_NAME: "pull_request_target",
    CANDIDATE_MODE: "plan",
    PASEO_RELEASE_APP_ID: "1",
    PASEO_RELEASE_APP_CLIENT_ID: "Ivtest",
    PASEO_RELEASE_BOT_ID: "456",
    PASEO_RELEASE_BOT_LOGIN: identity.botLogin,
  };
  const event = { repository: repo, action: "closed", pull_request: setup().current };
  const output = [];
  let draft;
  const assets = new Map();
  const pair = generateKeyPairSync("ed25519");
  const api = {
    publicPin: pair.publicKey.export({ format: "jwk" }).x,
    ref: async () => null,
    list: async () => (draft ? [draft] : []),
    get: async () => draft,
    create: async (value) => {
      draft = { ...value, id: 42, assets: [] };
    },
    upload: async (_id, name, bytes) => {
      const asset = { id: assets.size + 1, name, size: bytes.length, state: "uploaded" };
      assets.set(asset.id, bytes);
      draft.assets.push(asset);
    },
    read: async (asset) => assets.get(asset.id),
  };
  const execute = (overrides) =>
    candidateEntry({
      event,
      env: entryEnv,
      read,
      request: setup().request,
      api,
      output: async (text) => output.push(text),
      ...overrides,
    });
  const descriptor = await execute();
  for (const file of ["package.json", ".release-please-manifest.json"]) {
    await assert.rejects(
      execute({
        read: async (sha, name) =>
          name === file ? (await read(sha, name)).replace("0.1.0", "0.1.1") : read(sha, name),
      }),
    );
  }
  assert.equal(draft, undefined, "Read-only plan must not allocate storage");
  const issueEnv = {
    ...entryEnv,
    CANDIDATE_MODE: "issue",
    EXPECTED_DESCRIPTOR_DIGEST: descriptorDigest(descriptor),
    PASEO_RELEASE_MANIFEST_PRIVATE_KEY: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  await assert.rejects(execute({ env: { ...issueEnv, EXPECTED_DESCRIPTOR_DIGEST: "wrong" } }));
  assert.equal(draft, undefined);
  await execute({ env: issueEnv });
  assert.equal(draft.assets.length, 2);
  assert.ok(output.includes("release_id=42\n"));
  const retryEvent = { repository: repo, sender: { id: 7889894 }, inputs: { release_id: "42" } };
  const retryEnv = {
    ...issueEnv,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "iExalt",
    PASEO_RELEASE_MANIFEST_PRIVATE_KEY: undefined,
  };
  await execute({
    event: retryEvent,
    env: retryEnv,
    request: async (url) => {
      assert.ok(!url.includes("/actions/"), "Retry must not depend on expired logs");
      return setup().request(url);
    },
  });
  assert.equal(draft.assets.length, 2);
  assert.throws(() => candidateRoute({ ...retryEvent, sender: { id: 999 } }, retryEnv));
  await assert.rejects(
    currentCandidate(descriptor, dev, identity, setup().request, async (sha, file) =>
      file === ".github/fork-release.json"
        ? JSON.stringify({ ...fork, version: "0.1.1" })
        : read(sha, file),
    ),
  );
  await assert.rejects(
    currentCandidate(descriptor, head, identity, setup().request, async (sha, file) =>
      sha === head ? "new policy" : read(sha, file),
    ),
    /Policy changed/,
  );
  for (const mutate of [
    (f) => {
      f.current.user.id = 999;
    },
    (f) => {
      f.current.base.ref = "ci/release-please-rehearsal";
    },
    (f) => {
      f.current.merged = false;
    },
    (f) => {
      f.current.merge_commit_sha = head;
    },
    (f) => {
      f.current.commits = 2;
    },
    (f) => {
      f.commit.parents.push({ sha: head });
    },
    (f) => {
      f.commit.tree.sha = base;
    },
    (f) => {
      f.ancestry.status = "diverged";
    },
    (f) => {
      f.ancestry.base_commit.sha = head;
    },
    (f) => {
      f.onFinal = (currentPr) => {
        currentPr.merge_commit_sha = head;
      };
    },
  ]) {
    const f = setup();
    mutate(f);
    await assert.rejects(verifyMergedPrChecks(7, source, identity, f.request));
  }
});

test("current-head verifier requires both latest gates, exact setup receipts and unchanged PR", async () => {
  const good = fixture();
  const proof = await verifyCurrentPrChecks(7, identity, good.request);
  assert.equal(proof.headSha, head);
  assert.equal(proof.proofs.length, 2);
  for (const mutate of [
    (f) => {
      f.current.commits = 2;
    },
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
  const finalCommit = { sha: merge, parents: [{ sha: base }], tree: { sha: proof.treeSha } };
  const finalRefs = { returnedSha: merge, branchSha: merge };
  assert.equal(verifyRehearsalMerge(merged, finalCommit, proof, finalRefs), merge);
  assert.throws(() =>
    verifyRehearsalMerge(merged, { ...finalCommit, sha: head }, proof, finalRefs),
  );
  assert.throws(() =>
    verifyRehearsalMerge(merged, { ...finalCommit, parents: [{ sha: head }] }, proof, finalRefs),
  );
  assert.throws(() =>
    verifyRehearsalMerge(
      { ...merged, base: { ...pr.base, ref: "dev" } },
      finalCommit,
      proof,
      finalRefs,
    ),
  );
  assert.throws(() =>
    verifyRehearsalMerge(merged, { ...finalCommit, tree: { sha: head } }, proof, finalRefs),
  );
  assert.throws(() =>
    verifyRehearsalMerge(merged, finalCommit, proof, { ...finalRefs, branchSha: head }),
  );
  assert.throws(() =>
    verifyRehearsalMerge({ ...merged, commits: 2 }, finalCommit, proof, finalRefs),
  );
});
