import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateEntry } from "../.github/scripts/candidate-entry.mjs";
import { currentCandidate, candidateRoute } from "../.github/scripts/candidate-authority.mjs";
import { descriptorDigest } from "../.github/scripts/candidate-descriptor.mjs";
import { draftBody } from "../.github/scripts/candidate-draft.mjs";
import { workerGate, readTrustedWorkerContext } from "../.github/scripts/candidate-worker.mjs";
import { grantGroups } from "../.github/scripts/candidate-grant.mjs";
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

test("merged authority binds the old checked tree and parent while dev advances", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let rootEvent = "pull_request_target";
  const source = "e".repeat(40),
    dev = "f".repeat(40);
  const setup = () => {
    const f = fixture();
    for (const run of f.runs) run.pull_requests = [];
    Object.assign(f.current, { state: "closed", merged: true, merge_commit_sha: source });
    f.current.base = { ...f.current.base, ref: "dev", sha: dev };
    f.current.head.ref = "release-please--branches--dev--components--paseo";
    f.commit = { sha: source, parents: [{ sha: base }], tree: { sha: "d".repeat(40) } };
    f.ancestry = { status: "ahead", base_commit: { sha: source } };
    const request = f.request;
    f.request = async (url) => {
      if (url.endsWith("/actions/runs/500"))
        return {
          id: 500,
          run_attempt: 1,
          repository: repo,
          path: ".github/workflows/release-candidate.yml",
          head_sha: rootEvent === "workflow_dispatch" ? dev : head,
          head_branch: rootEvent === "workflow_dispatch" ? "dev" : f.current.head.ref,
          event: rootEvent,
          status: "in_progress",
          conclusion: null,
          actor: { id: 7889894, login: "iExalt" },
        };
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
  const read = async (sha, file) =>
    sha === base && file === ".release-please-manifest.json"
      ? JSON.stringify({ ".": "0.0.0" })
      : (sourceFiles[file] ?? "trusted policy fixture");
  const entryEnv = {
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: "refs/heads/dev",
    GITHUB_SHA: source,
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: join(directory, "event.json"),
    CANDIDATE_MODE: "plan",
    PASEO_RELEASE_APP_ID: "1",
    PASEO_RELEASE_APP_CLIENT_ID: "Ivtest",
    PASEO_RELEASE_BOT_ID: "456",
    PASEO_RELEASE_BOT_LOGIN: identity.botLogin,
  };
  const event = { repository: repo, action: "closed", pull_request: setup().current };
  await writeFile(entryEnv.GITHUB_EVENT_PATH, JSON.stringify(event));
  const output = [];
  let draft;
  const assets = new Map();
  const pair = generateKeyPairSync("ed25519");
  const api = {
    setBody: async (_id, body) => {
      draft.body = body;
    },
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
  await assert.rejects(
    execute({
      env: issueEnv,
      request: async (url) => {
        const response = await setup().request(url);
        return url.endsWith("/actions/runs/500") ? { ...response, head_sha: source } : response;
      },
    }),
  );
  assert.equal(draft, undefined, "Invalid root must not create draft authority");
  assert.equal(assets.size, 0, "Invalid root must not upload authority");
  await execute({ env: issueEnv });
  assert.equal(draft.assets.length, 2);
  assert.ok(output.includes("release_id=42\n"));
  const workerEnv = {
    ...entryEnv,
    GITHUB_REPOSITORY: repo.full_name,
    GITHUB_WORKFLOW_REF: "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev",
    CANDIDATE_RELEASE_ID: "42",
    PASEO_CANDIDATE_SHA: source,
    CANDIDATE_DESCRIPTOR_DIGEST: descriptorDigest(descriptor),
  };
  assert.equal(
    (await workerGate(workerEnv, api, setup().request, read)).descriptor.sourceSha,
    source,
  );
  const context = await workerGate(workerEnv, api, setup().request, read);
  const group = "verification";
  const grant = {
    kind: "paseo-worker-grant",
    schemaVersion: 1,
    group,
    context,
    descriptor: assets.get(1).toString("utf8"),
    signature: assets.get(2).toString("ascii"),
    workers: grantGroups[group].workers,
    authenticationJobId: 900,
  };
  const authJob = {
    id: 900,
    name: grantGroups[group].job,
    run_id: context.runId,
    run_attempt: context.attempt,
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "Upload authenticated worker grant", status: "completed", conclusion: "success" },
    ],
  };
  const grantedEnv = {
    ...workerEnv,
    CANDIDATE_GRANT_GROUP: group,
    CANDIDATE_EXPECTED_JOB: grant.workers[0],
  };
  const grantedRequest = async (url) =>
    url.includes("/jobs?") ? { jobs: [authJob] } : setup().request(url);
  const readonlyApi = {
    publicPin: api.publicPin,
    get: () => assert.fail("Readonly workers must not fetch drafts"),
  };
  assert.deepEqual(await workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant), context);
  for (const mutate of [
    (g) => {
      g.context.attempt++;
    },
    (g) => {
      g.group = "runtime";
    },
    (g) => {
      g.workers = ["native-runtime / android"];
    },
    (g) => {
      g.authenticationJobId++;
    },
    (g) => {
      g.signature = "A".repeat(86);
    },
  ]) {
    const bad = structuredClone(grant);
    mutate(bad);
    await assert.rejects(workerGate(grantedEnv, readonlyApi, grantedRequest, read, bad));
  }
  await assert.rejects(
    workerGate(
      { ...grantedEnv, CANDIDATE_EXPECTED_JOB: "native-runtime / android" },
      readonlyApi,
      grantedRequest,
      read,
      grant,
    ),
  );
  authJob.conclusion = "failure";
  await assert.rejects(workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant));
  authJob.conclusion = "success";
  authJob.steps[0].conclusion = "failure";
  await assert.rejects(workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant));
  authJob.steps[0].conclusion = "success";
  await assert.rejects(
    readTrustedWorkerContext({ CANDIDATE_GRANT_ID: "456" }),
    /cannot use a worker grant/,
  );
  await assert.rejects(
    workerGate(
      grantedEnv,
      readonlyApi,
      async (url) => {
        const value = await grantedRequest(url);
        return url.endsWith("/actions/runs/500")
          ? { ...value, status: "completed", conclusion: "cancelled" }
          : value;
      },
      read,
      grant,
    ),
  );
  await assert.rejects(
    workerGate({ ...workerEnv, PASEO_CANDIDATE_SHA: head }, api, setup().request, read),
    /another candidate/,
  );
  await assert.rejects(
    workerGate({ ...workerEnv, GITHUB_RUN_ATTEMPT: "2" }, api, setup().request, read),
  );
  await assert.rejects(
    workerGate(
      { ...workerEnv, GITHUB_RUN_ATTEMPT: "2" },
      api,
      async (url) => {
        const response = await setup().request(url);
        return url.endsWith("/actions/runs/500") ? { ...response, run_attempt: 2 } : response;
      },
      read,
    ),
    /no longer admitted/,
  );
  const retryEvent = { repository: repo, sender: { id: 7889894 }, inputs: { release_id: "42" } };
  const retryEnv = {
    ...issueEnv,
    GITHUB_SHA: dev,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "iExalt",
    PASEO_RELEASE_MANIFEST_PRIVATE_KEY: undefined,
  };
  rootEvent = "workflow_dispatch";
  const initialEvent = { ...retryEvent, inputs: { merged_pr: "7" } };
  for (const inputs of [
    {},
    { merged_pr: "7", release_id: "42" },
    { merged_pr: "0" },
    { merged_pr: "1e2" },
  ])
    assert.throws(() => candidateRoute({ ...initialEvent, inputs }, retryEnv));
  assert.throws(() => candidateRoute(initialEvent, { ...retryEnv, GITHUB_ACTOR: "someone-else" }));
  await execute({
    event: retryEvent,
    env: retryEnv,
    request: async (url) => {
      assert.ok(
        !url.includes("/actions/") || url.endsWith("/actions/runs/500"),
        "Retry must not depend on expired logs",
      );
      return setup().request(url);
    },
  });
  assert.equal(draft.assets.length, 2);
  assert.throws(() => candidateRoute({ ...retryEvent, sender: { id: 999 } }, retryEnv));
  for (const override of [
    { status: "completed" },
    { run_attempt: 2 },
    { head_sha: head },
    { path: ".github/workflows/ci.yml" },
    { actor: { id: 999, login: "iExalt" } },
    { repository: { ...repo, id: 999 } },
  ]) {
    const originalBody = draft.body;
    await assert.rejects(
      execute({
        event: retryEvent,
        env: retryEnv,
        request: async (url) => {
          const response = await setup().request(url);
          return url.endsWith("/actions/runs/500") ? { ...response, ...override } : response;
        },
      }),
    );
    assert.equal(draft.body, originalBody);
  }
  draft.body = draftBody(descriptor, "active", { runId: 501, attempt: 1 });
  await assert.rejects(execute({ event: retryEvent, env: retryEnv }), /Cannot regress/);
  draft.body = draftBody(descriptor, "active", { runId: 500, attempt: 2 });
  await assert.rejects(execute({ event: retryEvent, env: retryEnv }), /Cannot regress/);
  draft.body = draftBody(descriptor, "stopped", { runId: 500, attempt: 1 });
  await assert.rejects(execute({ event: retryEvent, env: retryEnv }), /stopped/);
  draft.body = draftBody(descriptor, "active", { runId: 500, attempt: 1 });
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
      f.logs.set(200, f.logs.get(200).replace('"prNumber":7', '"prNumber":8'));
    },
    (f) => {
      f.runs[0].conclusion = "failure";
    },
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
  // Recover initial issuance from a genuine merged PR before a draft exists.
  draft = undefined;
  assets.clear();
  const initialEnv = { ...retryEnv, CANDIDATE_MODE: "plan" };
  const initialDescriptor = await execute({ event: initialEvent, env: initialEnv });
  assert.equal(initialDescriptor.sourceSha, source);
  assert.equal(initialDescriptor.policy.sourceSha, dev);
  await assert.rejects(
    execute({
      event: initialEvent,
      env: {
        ...retryEnv,
        EXPECTED_DESCRIPTOR_DIGEST: descriptorDigest(initialDescriptor),
      },
    }),
  );
  assert.equal(draft, undefined, "Keyless initial issuance must not allocate a draft");
  await execute({
    event: initialEvent,
    env: {
      ...retryEnv,
      EXPECTED_DESCRIPTOR_DIGEST: descriptorDigest(initialDescriptor),
      PASEO_RELEASE_MANIFEST_PRIVATE_KEY: issueEnv.PASEO_RELEASE_MANIFEST_PRIVATE_KEY,
    },
  });
  assert.equal(draft.assets.length, 2);
});

test("current-head verifier requires both latest gates, exact setup receipts and unchanged PR", async () => {
  const good = fixture();
  const proof = await verifyCurrentPrChecks(7, identity, good.request);
  assert.equal(proof.headSha, head);
  assert.equal(proof.proofs.length, 2);
  const missing = fixture();
  const complete = structuredClone(missing.jobs[0][0]);
  missing.jobs[0][0].steps = [];
  const reconciled = await verifyCurrentPrChecks(7, identity, (route) =>
    route.endsWith("/actions/jobs/200") ? complete : missing.request(route),
  );
  assert.equal(reconciled.treeSha, proof.treeSha);
  for (const mutate of [
    (f) => {
      f.runs[0].pull_requests = [];
    },
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
