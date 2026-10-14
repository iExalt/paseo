import assert from "node:assert/strict";
import { proposalRef, pushProposal } from "./proposal-git.mjs";
import { assertReleasePr } from "../scripts/release-pr.mjs";

const repository = "/repos/iExalt/paseo";
const pending = "autorelease: pending";
const superseded = "autorelease: superseded";
export function proposalRequest(token) {
  assert.ok(token);
  return async (route, method = "GET", body) => {
    assert.ok(route.startsWith(`${repository}/`));
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === "GET") return null;
    assert.ok(response.ok, `Proposal API ${method} failed (${response.status})`);
    if (response.status === 204) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 8 * 1024 * 1024, "Proposal API response exceeds limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}
function identityPr(pr, identity, branch, head) {
  // Creation precedes its label event. Never relax identity or head checks while
  // reconciling that small interval; labeling triggers the deep release gate.
  assertReleasePr({ ...pr, state: "open", labels: [{ name: pending }] }, identity, head);
  assert.equal(pr.base.ref, branch);
}

export async function publishProposal({
  prepared,
  identity,
  request,
  push = pushProposal,
  cwd,
  token,
  validate,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.equal(typeof validate, "function", "Proposal authorization is required");
  const { branch, base, sha, tree, expectedHead, title, body, previousPr } = prepared;
  const headRef = proposalRef(branch).slice("refs/heads/".length);
  for (const value of [base, sha, tree]) assert.match(value, /^[a-f0-9]{40}$/);
  assert.ok(expectedHead === "" || /^[a-f0-9]{40}$/.test(expectedHead));
  const headRoute = `${repository}/git/ref/heads/${headRef}`;
  const freshBase = async () =>
    assert.equal(
      (await request(`${repository}/git/ref/heads/${branch}`)).object.sha,
      base,
      "Target moved; regenerate the proposal",
    );
  const head = async () => (await request(headRoute))?.object.sha ?? "";
  const openPr = async () => {
    const rows = await request(
      `${repository}/pulls?state=open&head=iExalt:${encodeURIComponent(headRef)}&base=${encodeURIComponent(branch)}&per_page=100`,
    );
    assert.ok(Array.isArray(rows) && rows.length <= 1, "Ambiguous proposal PRs");
    if (!rows.length) return null;
    const pr = await request(`${repository}/pulls/${rows[0].number}`);
    assert.equal(pr.state, "open");
    identityPr(pr, identity, branch, pr.head.sha);
    return pr;
  };
  const verifyPublished = async () => {
    assert.equal(await head(), sha, "Proposal branch changed");
    const commit = await request(`${repository}/git/commits/${sha}`);
    assert.equal(commit.sha, sha);
    assert.equal(commit.tree.sha, tree);
    assert.deepEqual(
      commit.parents.map((parent) => parent.sha),
      [base],
    );
    await freshBase();
  };
  await freshBase();
  await validate();
  const current = await head();
  let pr = await openPr();
  if (current !== sha) {
    assert.equal(current, expectedHead, "Proposal branch moved; do not refresh its lease");
    if (pr) {
      identityPr(pr, identity, branch, expectedHead);
      assert.ok(pr.labels.some((label) => label.name === pending));
    } else if (expectedHead) {
      assert.ok(
        Number.isSafeInteger(previousPr) && previousPr > 0,
        "Existing branch requires an authenticated predecessor",
      );
      const previous = await request(`${repository}/pulls/${previousPr}`);
      identityPr(previous, identity, branch, expectedHead);
      assert.equal(previous.state, "closed");
      assert.equal(previous.merged, true);
    }
    await freshBase();
    try {
      await push({ cwd, branch, expectedHead, sha, token });
    } catch (error) {
      // A lost push response can be reconciled, but a lease failure never grants
      // permission to overwrite the writer that won the race.
      if ((await head()) !== sha) throw error;
    }
  }
  await verifyPublished();
  // The pulls API can report the previous head for seconds after a push. Wait,
  // boundedly, for exactly the pushed commit; any other head still fails below.
  const pushedPr = async () => {
    for (let attempt = 1; ; attempt++) {
      const visible = await openPr();
      if (!visible || visible.head.sha === sha || attempt === 6) return visible;
      await wait(5000);
    }
  };
  pr = await pushedPr();
  if (!pr) {
    try {
      await request(`${repository}/pulls`, "POST", {
        title,
        body,
        head: headRef,
        base: branch,
        maintainer_can_modify: false,
      });
    } catch (error) {
      if (!(await openPr())) throw error;
    }
    pr = await pushedPr();
    assert.ok(pr, "Created proposal is not visible; reconcile before retrying");
  }
  identityPr(pr, identity, branch, sha);
  assert.equal(pr.commits, 1);
  if (pr.title !== title || pr.body !== body)
    await request(`${repository}/pulls/${pr.number}`, "PATCH", { title, body });
  if (!pr.labels.some((label) => label.name === pending))
    await request(`${repository}/issues/${pr.number}/labels`, "POST", { labels: [pending] });
  pr = await request(`${repository}/pulls/${pr.number}`);
  assertReleasePr(pr, identity, sha);
  assert.equal(pr.title, title);
  assert.equal(pr.body, body);
  assert.equal(pr.base.ref, branch);
  assert.equal(pr.commits, 1);
  await verifyPublished();
  await validate();
  if (prepared.replacement) await supersedeProposal(prepared, identity, request);
  return pr;
}

async function supersedeProposal(prepared, identity, request) {
  const { previousPr, branch } = prepared;
  assert.equal(previousPr, prepared.replacement.supersededPr);
  const old = await request(`${repository}/pulls/${previousPr}`);
  identityPr(old, identity, branch, old.head.sha);
  assert.equal(old.state, "closed");
  assert.equal(old.merged, true);
  assert.equal(old.merge_commit_sha, prepared.replacement.supersededSource);
  assert.ok(old.labels.some((label) => [pending, superseded].includes(label.name)));
  const labelRoute = `${repository}/labels/${encodeURIComponent(superseded)}`;
  if (!(await request(labelRoute))) {
    try {
      await request(`${repository}/labels`, "POST", {
        name: superseded,
        color: "ededed",
        description: "Unpublished version proposal replaced by a verified successor",
      });
    } catch (error) {
      if ((await request(labelRoute))?.name !== superseded) throw error;
    }
    assert.equal((await request(labelRoute))?.name, superseded);
  }
  if (!old.labels.some((label) => label.name === superseded))
    await request(`${repository}/issues/${previousPr}/labels`, "POST", { labels: [superseded] });
  if (old.labels.some((label) => label.name === pending))
    await request(
      `${repository}/issues/${previousPr}/labels/${encodeURIComponent(pending)}`,
      "DELETE",
    );
  const labels = new Set(
    (await request(`${repository}/pulls/${previousPr}`)).labels.map((label) => label.name),
  );
  assert.ok(labels.has(superseded) && !labels.has(pending));
}
