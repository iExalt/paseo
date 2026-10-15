import assert from "node:assert/strict";
import test from "node:test";
import { publishProposal } from "./proposal-publish.mjs";

const identity = { botId: 341220930, botLogin: "paseo-release[bot]" };
const base = "a".repeat(40),
  oldHead = "b".repeat(40),
  sha = "c".repeat(40),
  tree = "d".repeat(40);
const pending = "autorelease: pending";
const repo = { id: 1404390841, full_name: "iExalt/paseo", private: false };
const branch = "release-please--branches--dev--components--paseo";
function fixture(options = {}) {
  let head = oldHead,
    currentBase = base,
    pushes = 0,
    creates = 0;
  const previous = {
    number: 74,
    user: { id: identity.botId, login: identity.botLogin, type: "Bot" },
    state: "closed",
    merged: true,
    merge_commit_sha: "e".repeat(40),
    head: { ref: branch, sha: oldHead, repo },
    base: { ref: "dev", sha: base, repo },
    labels: [{ name: pending }],
    commits: 1,
  };
  let pr;
  let staleReads = options.staleReads ?? 0;
  let staleRefReads = options.staleRefReads ?? 0;
  if (options.openBeforePush)
    pr = {
      ...structuredClone(previous),
      number: 81,
      state: "open",
      merged: false,
      labels: [{ name: pending }],
      title: "old",
      body: "old",
    };
  const prepared = {
    branch: "dev",
    base,
    sha,
    tree,
    expectedHead: oldHead,
    title: "chore(dev): release 0.1.0",
    body: "Release notes.",
    previousPr: 74,
  };
  const labelsRequest = async (route, method, body) => {
    if (route === "issues/81/labels") {
      pr.labels = body.labels.map((name) => ({ name }));
      return pr.labels;
    }
    throw new Error(`Unexpected labels API ${method} ${route}`);
  };
  const request = async (full, method = "GET", body) => {
    const route = full.replace("/repos/iExalt/paseo/", "");
    if (route === "git/ref/heads/dev") return { object: { sha: currentBase } };
    if (route === `git/ref/heads/${branch}`)
      return { object: { sha: head === sha && staleRefReads-- > 0 ? oldHead : head } };
    if (route === `git/commits/${sha}`)
      return { sha, tree: { sha: tree }, parents: [{ sha: base }] };
    if (route.startsWith("pulls?")) return pr ? [{ number: pr.number }] : [];
    if (route === "pulls/74") return structuredClone(previous);
    if (route === "pulls" && method === "POST") {
      creates++;
      pr = {
        ...structuredClone(previous),
        number: 81,
        state: "open",
        merged: false,
        head: { ...previous.head, sha },
        labels: [],
        title: body.title,
        body: body.body,
      };
      if (options.lostCreate) throw new Error("Lost create response");
      return structuredClone(pr);
    }
    if (route === "pulls/81") {
      if (method === "PATCH") Object.assign(pr, body);
      if (head === sha && pr.head.sha !== sha && staleReads-- <= 0) pr.head.sha = sha;
      return structuredClone(pr);
    }
    return labelsRequest(route, method, body);
  };
  const push = async ({ expectedHead }) => {
    pushes++;
    assert.equal(expectedHead, oldHead);
    if (options.leaseRace) {
      head = "f".repeat(40);
      throw new Error("Lease rejected");
    }
    head = sha;
    if (options.lostPush) throw new Error("Lost push response");
  };
  return {
    args: {
      prepared,
      identity,
      request,
      push,
      cwd: "/unused",
      token: "unused",
      validate: async () => {},
    },
    get counts() {
      return { pushes, creates };
    },
    get labels() {
      return previous.labels.map((label) => label.name);
    },
    moveBase() {
      currentBase = "f".repeat(40);
    },
  };
}

test("publisher reconciles lost push/create replies without duplicates", async () => {
  const state = fixture({ lostPush: true, lostCreate: true });
  const result = await publishProposal(state.args);
  assert.equal(result.number, 81);
  assert.deepEqual(result.labels, [{ name: pending }]);
  assert.deepEqual(state.counts, { pushes: 1, creates: 1 });
});

test("publisher stops on branch race, target movement and rejected predecessor authority", async () => {
  const missing = fixture();
  await assert.rejects(
    publishProposal({ ...missing.args, validate: undefined }),
    /authorization is required/,
  );
  assert.deepEqual(missing.counts, { pushes: 0, creates: 0 });
  const race = fixture({ leaseRace: true });
  await assert.rejects(publishProposal(race.args), /Lease rejected/);
  assert.deepEqual(race.counts, { pushes: 1, creates: 0 });
  assert.deepEqual(race.labels, [pending]);
  const moved = fixture();
  moved.moveBase();
  await assert.rejects(publishProposal(moved.args), /Target moved/);
  assert.deepEqual(moved.counts, { pushes: 0, creates: 0 });
  const denied = fixture();
  await assert.rejects(
    publishProposal({
      ...denied.args,
      validate: async () => {
        throw new Error("Active predecessor");
      },
    }),
    /Active predecessor/,
  );
  assert.deepEqual(denied.counts, { pushes: 0, creates: 0 });
  const forged = fixture();
  await assert.rejects(publishProposal({ ...forged.args, identity: { ...identity, botId: 1 } }));
  assert.deepEqual(forged.counts, { pushes: 0, creates: 0 });
});

test("publisher waits boundedly for the refs and pulls APIs to report exactly the pushed head", async () => {
  const refWaits = [];
  const refLag = fixture({ staleRefReads: 2 });
  await publishProposal({ ...refLag.args, wait: async (ms) => refWaits.push(ms) });
  assert.deepEqual(refWaits, [5000, 5000]);
  const lostPushLag = fixture({ lostPush: true, staleRefReads: 2 });
  assert.equal((await publishProposal({ ...lostPushLag.args, wait: async () => {} })).number, 81);
  const refStuck = fixture({ staleRefReads: 99 });
  await assert.rejects(
    publishProposal({ ...refStuck.args, wait: async () => {} }),
    /Proposal branch changed/,
  );
  const waits = [];
  const lagging = fixture({ openBeforePush: true, staleReads: 2 });
  const result = await publishProposal({
    ...lagging.args,
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(result.head.sha, sha);
  assert.deepEqual(waits, [5000, 5000]);
  const stuck = fixture({ openBeforePush: true, staleReads: 99 });
  await assert.rejects(
    publishProposal({ ...stuck.args, wait: async () => {} }),
    /PR head changed; fresh verification required/,
  );
});
