import assert from "node:assert/strict";
import { attemptRoute } from "./candidate-ledger-fixture.mjs";
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
import { grantGroups, validateGrant } from "../.github/scripts/candidate-grant.mjs";
import { attemptLedger } from "../.github/scripts/candidate-attempts.mjs";
import { sourceReceipt, validateSourceReceipt } from "../.github/scripts/ci-source-receipt.mjs";
import { stepProofSubject, replaceStepProofVerifier } from "../.github/scripts/step-proof.mjs";
import { signedProof } from "./step-proof-fixture.mjs";
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
// Proofs come from the latest fixture so each mutation reaches the verifier.
let store = { proofs: [] };
const candidateProofs = [];
const restoreProofs = replaceStepProofVerifier(
  async (subject) => {
    const results = [...store.proofs, ...candidateProofs]
      .filter((spec) => stepProofSubject(spec.runId, spec.attempt, spec.slot) === subject)
      .map((spec) => signedProof(spec));
    if (!results.length) throw new Error("No attestation for subject");
    return results;
  },
  async () => {},
);
test.after(restoreProofs);

test("checkout receipts distinguish merge verification from exact-head deep and push checks", () => {
  const git = (...args) => (args[0] === "rev-parse" ? merge : `${base} ${head}`);
  const receipt = sourceReceipt(env, git);
  assert.equal(receipt.kind, "routine-pr");
  assert.deepEqual(validateSourceReceipt(structuredClone(receipt)), receipt);
  assert.throws(() => validateSourceReceipt({ ...receipt, extra: true }));
  assert.throws(() => validateSourceReceipt({ ...receipt, schemaVersion: 2 }));
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
      // GitHub's step records are not authority; empty lists must not matter.
      steps: [],
    })),
  );
  const proofs = [];
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
      proofs.push({
        runId: 100 + index,
        attempt: 1,
        slot: index ? `ci-source-deep-${lane}` : "ci-source-routine",
        workflow: index ? "ci-deep.yml" : "ci.yml",
        ref: "refs/pull/7/merge",
        sourceSha: merge,
        evidence: receipt,
      });
    }
  let prReads = 0;
  const state = { runs, jobs, proofs, current: structuredClone(pr), onFinal: () => {} };
  store = state;
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
  const baseFiles = {
    ".release-please-manifest.json": JSON.stringify({ ".": "0.0.0" }),
    ".github/fork-release.json": JSON.stringify({ ...fork, version: "0.0.0" }),
  };
  const read = async (sha, file) =>
    (sha === base ? baseFiles[file] : undefined) ?? sourceFiles[file] ?? "trusted policy fixture";
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
    started_at: "2026-10-12T12:00:00Z",
    completed_at: "2026-10-12T12:01:00Z",
    steps: [],
  };
  const grantProof = {
    runId: context.runId,
    attempt: context.attempt,
    slot: "grant-verification",
    workflow: "candidate-auth.yml",
    sourceSha: context.controllerSha,
    evidence: { artifactId: 77, artifactDigest: "7".repeat(64) },
  };
  candidateProofs.push(grantProof);
  const grantedEnv = {
    ...workerEnv,
    CANDIDATE_GRANT_GROUP: group,
    CANDIDATE_EXPECTED_JOB: grant.workers[0],
    CANDIDATE_GRANT_ID: "77",
    CANDIDATE_GRANT_DIGEST: "7".repeat(64),
  };
  const grantedRequest = async (url) =>
    attemptRoute(url, [authJob], context.attempt) ?? setup().request(url);
  const readonlyApi = {
    publicPin: api.publicPin,
    get: () => assert.fail("Readonly workers must not fetch drafts"),
  };
  assert.deepEqual(await workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant), context);
  // A grant issued alongside its producers must still be live when used.
  const signing = "android-sign";
  const preIssued = { ...grant, group: signing, workers: grantGroups[signing].workers };
  const signJob = { ...authJob, name: grantGroups[signing].job };
  candidateProofs.push({ ...grantProof, slot: `grant-${signing}` });
  const signEnv = {
    ...grantedEnv,
    CANDIDATE_GRANT_GROUP: signing,
    CANDIDATE_EXPECTED_JOB: preIssued.workers[0],
  };
  const signRequest = async (url) =>
    url.includes("/workflows/release-candidate.yml/runs")
      ? { workflow_runs: [{ id: context.runId }] }
      : (attemptRoute(url, [signJob], context.attempt) ?? setup().request(url));
  await assert.rejects(
    workerGate(signEnv, readonlyApi, signRequest, read, preIssued),
    /live native authorization/,
  );
  assert.deepEqual(
    await workerGate(
      { ...signEnv, CANDIDATE_LIVE_NATIVE: "true" },
      readonlyApi,
      signRequest,
      read,
      preIssued,
    ),
    context,
  );
  candidateProofs.pop();
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
  // The grant proof must name this upload and come from this attempt's controller.
  for (const [key, value] of [
    ["evidence", { artifactId: 78, artifactDigest: "7".repeat(64) }],
    ["evidence", { artifactId: 77, artifactDigest: "8".repeat(64) }],
    ["sourceSha", head],
    ["workflow", "ci.yml"],
  ]) {
    candidateProofs[0] = { ...grantProof, [key]: value };
    await assert.rejects(workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant));
  }
  candidateProofs.length = 0;
  await assert.rejects(workerGate(grantedEnv, readonlyApi, grantedRequest, read, grant), /verify/);
  candidateProofs.push(grantProof);
  // A worker rerun in attempt 2 keeps the grant from the authentication job's
  // last execution: a clone carries attempt 1, a genuine rerun supersedes it.
  const rerunAttempts = (second) => {
    const starts = ["2026-10-12T11:00:00Z", "2026-10-12T13:00:00Z"];
    const lists = [[authJob], [{ ...authJob, id: 901, run_attempt: 2, ...second }]];
    return attemptLedger({ runId: context.runId, attempt: 2 }, async (url) => {
      const [, number, jobs] = url.match(/\/attempts\/(\d)(\/jobs)?/);
      return jobs
        ? { jobs: lists[number - 1] }
        : { id: context.runId, run_attempt: Number(number), run_started_at: starts[number - 1] };
    });
  };
  const later = { ...context, attempt: 2 };
  const grantArtifact = { id: "77", digest: "7".repeat(64) };
  const check = (value, ledger) =>
    validateGrant(value, later, group, grant.workers[0], ledger, api.publicPin, grantArtifact);
  assert.equal(context.attempt, 1);
  await check(grant, rerunAttempts({}));
  await assert.rejects(check({ ...grant, context: later }, rerunAttempts({})), /latest/);
  const reauthenticated = {
    started_at: "2026-10-12T13:05:00Z",
    completed_at: "2026-10-12T13:06:00Z",
  };
  await assert.rejects(check(grant, rerunAttempts(reauthenticated)), /latest/);
  await assert.rejects(
    check({ ...grant, context: later, authenticationJobId: 901 }, rerunAttempts(reauthenticated)),
    /verify/,
  );
  candidateProofs.push({ ...grantProof, attempt: 2 });
  await check(
    { ...grant, context: later, authenticationJobId: 901 },
    rerunAttempts(reauthenticated),
  );
  candidateProofs.pop();
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
  // A trusted job executing a rerun attempt of the admitted run advances it;
  // the attempt never moves back.
  const rerun = async (url) => {
    const response = await setup().request(url);
    return url.endsWith("/actions/runs/500") ? { ...response, run_attempt: 2 } : response;
  };
  await workerGate({ ...workerEnv, GITHUB_RUN_ATTEMPT: "2" }, api, rerun, read);
  assert.deepEqual(JSON.parse((await api.get(42)).body).activeAttempt, { runId: 500, attempt: 2 });
  await assert.rejects(workerGate(workerEnv, api, setup().request, read), /regress/);
  draft.body = draftBody(descriptor, "active", { runId: 500, attempt: 1 });
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
  // The candidate trigger's path filter relies on every release changing this file.
  await assert.rejects(
    currentCandidate(descriptor, dev, identity, setup().request, async (sha, file) =>
      sha === base && file === ".github/fork-release.json" ? JSON.stringify(fork) : read(sha, file),
    ),
    /must change its release configuration/,
  );
  await assert.rejects(
    currentCandidate(descriptor, dev, identity, setup().request, async (sha, file) =>
      sha === source && file === ".github/fork-release.json"
        ? JSON.stringify({ ...fork, version: "0.0.0" })
        : read(sha, file),
    ),
    // sourceVersion rejects this first; replacementForSource repeats it locally.
    /differs from fork version|must change its release configuration/,
  );
  for (const mutate of [
    (f) => {
      f.proofs[0].evidence.prNumber = 8;
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

test("current-head verifier requires both latest gates, signed source receipts and unchanged PR", async () => {
  const good = fixture();
  const proof = await verifyCurrentPrChecks(7, identity, good.request);
  assert.equal(proof.headSha, head);
  assert.equal(proof.proofs.length, 2);
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
      f.proofs.shift();
    },
    (f) => {
      f.proofs[0].evidence.baseSha = head;
    },
    (f) => {
      f.proofs[0].sourceSha = head;
    },
    (f) => {
      f.proofs[0].attempt = 2;
    },
    (f) => {
      f.proofs[1].ref = "refs/heads/dev";
    },
    (f) => {
      f.proofs[2].sourceSha = "e".repeat(40);
    },
    (f) => {
      f.proofs[1].workflow = "ci.yml";
    },
    (f) => {
      f.proofs.push({ ...f.proofs[1], evidence: { ...f.proofs[1].evidence, lane: "electron" } });
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
  // Fields as returned for the all-skipped ci-deep run 38506011584.
  const skipped = {
    ...good.runs[1],
    id: 103,
    run_attempt: 1,
    status: "completed",
    conclusion: "skipped",
  };
  assert.equal(latestPrRun([good.runs[1], skipped], "ci-deep.yml", pr), good.runs[1]);
  for (const conclusion of ["failure", "cancelled"])
    assert.throws(
      () =>
        latestPrRun(
          [good.runs[1], skipped, { ...skipped, id: 104, conclusion }],
          "ci-deep.yml",
          pr,
        ),
      /did not succeed/,
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
