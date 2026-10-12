import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertReleasePr } from "./release-pr.mjs";
import { releaseBotIdentity } from "./release-app-auth.mjs";
import { compareForkVersions, forkVersionFromTag } from "../../scripts/fork-version.mjs";
import { fileIdentity } from "./candidate-files.mjs";
import {
  descriptorBytes,
  descriptorDigest,
  draftTag,
  validateDescriptor,
  verifyDescriptor,
} from "./candidate-descriptor.mjs";

const descriptorName = "candidate-descriptor.json";
const signatureName = "candidate-descriptor.sig";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
}
export function draftBody(descriptor, state = "active", activeAttempt = null) {
  assert.ok(["active", "stopped"].includes(state));
  if (activeAttempt !== null) {
    assert.deepEqual(Object.keys(activeAttempt).sort(), ["attempt", "runId"]);
    positive(activeAttempt.runId);
    positive(activeAttempt.attempt);
    activeAttempt = { runId: activeAttempt.runId, attempt: activeAttempt.attempt };
  }
  return JSON.stringify({
    kind: "paseo-candidate-storage",
    schemaVersion: 1,
    descriptorSha256: descriptorDigest(descriptor),
    state,
    activeAttempt,
  });
}
export function validateDraft(release, descriptor, active = true, inventory = true) {
  validateDescriptor(descriptor);
  positive(release.id);
  assert.equal(release.draft, true, "Candidate storage is no longer a draft");
  assert.equal(release.prerelease, false);
  assert.equal(release.tag_name, draftTag(descriptor));
  assert.equal(release.target_commitish, descriptor.sourceSha);
  assert.equal(release.name, draftTag(descriptor));
  const body = JSON.parse(release.body);
  assert.equal(release.body, draftBody(descriptor, body.state, body.activeAttempt));
  if (active) assert.equal(body.state, "active", "Candidate has stopped");
  if (!inventory) return release;
  assert.ok(Array.isArray(release.assets));
  const names = new Set();
  for (const asset of release.assets) {
    positive(asset.id);
    assert.ok(!names.has(asset.name), "Duplicate immutable asset");
    names.add(asset.name);
  }
  return release;
}

// Adapter contract: list() returns every release (including drafts); get/ref/read
// are fresh reads. All writes run under the coordinator's global concurrency lock.
export async function eligibleDraft(api, descriptor, existingId) {
  let releases;
  if (api.lifecycle) releases = await api.lifecycle(descriptor);
  else {
    assert.equal(await api.ref(descriptor.releaseTag), null, "Final tag already exists");
    assert.equal(await api.ref(draftTag(descriptor)), null, "Transport tag already exists");
    releases = await api.list();
  }
  let selected;
  for (const release of releases) {
    const version = forkVersionFromTag(release.tag_name);
    if (version !== null) {
      assert.ok(
        compareForkVersions(version, descriptor.version) < 0,
        "Candidate is superseded or final tag is reserved",
      );
    }
    if (release.tag_name === draftTag(descriptor)) {
      assert.equal(selected, undefined, "Duplicate candidate draft");
      selected = validateDraft(release, descriptor, true, false);
    } else if (release.tag_name?.startsWith(`paseo-candidate-v${descriptor.version}-`)) {
      // Replacement authority requires a verifiable stopped predecessor, not a
      // mutable body claiming it stopped or an arbitrary similarly named draft.
      const prior = await loadDescriptor(api, release.id);
      validateDraft(release, prior, false, false);
      assert.equal(
        JSON.parse(release.body).state,
        "stopped",
        "Another source is active for this version",
      );
    }
  }
  if (existingId !== undefined) {
    assert.equal(selected?.id, existingId, "Candidate draft identity changed");
    return selected;
  }
  return selected;
}

export async function loadDescriptor(api, releaseId) {
  positive(releaseId);
  const release = await api.get(releaseId);
  const find = (name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    assert.equal(matches.length, 1, "Missing or duplicate candidate authority");
    return matches[0];
  };
  const bytes = await api.read(find(descriptorName), 16384);
  const signature = await api.read(find(signatureName), 86);
  const descriptor = verifyDescriptor(bytes, signature.toString("ascii"), api.publicPin);
  validateDraft(release, descriptor, false);
  return descriptor;
}

async function immutablePayload(
  api,
  descriptor,
  id,
  name,
  payload,
  guard = () => eligibleDraft(api, descriptor, id),
) {
  const check = async (asset) => {
    assert.equal(asset.state, "uploaded");
    assert.equal(asset.size, payload.bytes);
    await payload.verify(asset);
    await guard();
    return asset;
  };
  await guard();
  const release = validateDraft(await api.get(id), descriptor);
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) return check(existing);
  try {
    await payload.upload();
  } catch (error) {
    // A lost response is not permission to overwrite. Reconcile the exact name
    // and bytes before deciding whether the interrupted operation succeeded.
    const reconciled = validateDraft(await api.get(id), descriptor);
    const asset = reconciled.assets.find((item) => item.name === name);
    if (!asset) throw error;
    return check(asset);
  }
  const completed = validateDraft(await api.get(id), descriptor);
  const asset = completed.assets.find((item) => item.name === name);
  assert.ok(asset, "Uploaded asset is absent");
  return check(asset);
}

async function immutableBytes(api, descriptor, id, name, bytes, guard) {
  return immutablePayload(
    api,
    descriptor,
    id,
    name,
    {
      bytes: bytes.length,
      upload: () => api.upload(id, name, bytes),
      verify: async (asset) => {
        const actual = await api.read(asset, bytes.length);
        assert.equal(actual.length, bytes.length);
        assert.equal(digest(actual), digest(bytes), "Immutable asset content differs");
      },
    },
    guard,
  );
}

export async function ensureDraft(api, descriptor, signature) {
  const bytes = descriptorBytes(descriptor);
  verifyDescriptor(bytes, signature, api.publicPin);
  let release = await eligibleDraft(api, descriptor);
  if (!release) {
    try {
      await api.create({
        tag_name: draftTag(descriptor),
        target_commitish: descriptor.sourceSha,
        name: draftTag(descriptor),
        body: draftBody(descriptor),
        draft: true,
        prerelease: false,
      });
    } catch (error) {
      release = await eligibleDraft(api, descriptor);
      if (!release) throw error;
    }
    release = await eligibleDraft(api, descriptor);
    assert.ok(release, "Created draft is absent");
  }
  await immutableBytes(api, descriptor, release.id, descriptorName, bytes);
  await immutableBytes(api, descriptor, release.id, signatureName, Buffer.from(signature));
  assert.deepEqual(await loadDescriptor(api, release.id), descriptor);
  return release.id;
}

export function attemptAssetName(runId, attempt, name) {
  positive(runId);
  positive(attempt);
  assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/);
  return `run-${runId}-attempt-${attempt}-${name}`;
}
// Immutable authority may be retained only for this authenticated invocation.
// Every individual write still performs fresh lifecycle checks before and after
// transfer, and uses a complete paginated inventory for immutable reconciliation.
export async function attemptWriter(api, descriptor, id, runId, attempt) {
  assert.deepEqual(await loadDescriptor(api, id), descriptor);
  const guard = () => requireAttempt(api, descriptor, id, runId, attempt);
  return {
    bytes(name, bytes) {
      return immutableBytes(
        api,
        descriptor,
        id,
        attemptAssetName(runId, attempt, name),
        bytes,
        guard,
      );
    },
    file(name, file, expected) {
      fileIdentity(expected);
      const assetName = attemptAssetName(runId, attempt, name);
      return immutablePayload(
        api,
        descriptor,
        id,
        assetName,
        {
          bytes: expected.bytes,
          upload: () => api.uploadFile(id, assetName, file, expected),
          verify: (asset) => api.verifyFile(asset, expected),
        },
        guard,
      );
    },
  };
}
export async function uploadAttemptBytes(api, descriptor, id, runId, attempt, name, bytes) {
  return (await attemptWriter(api, descriptor, id, runId, attempt)).bytes(name, bytes);
}
export async function uploadAttemptFile(api, descriptor, id, runId, attempt, name, file, expected) {
  return (await attemptWriter(api, descriptor, id, runId, attempt)).file(name, file, expected);
}

export async function requireAttempt(api, descriptor, id, runId, attempt) {
  positive(runId);
  positive(attempt);
  const release = await eligibleDraft(api, descriptor, id);
  assert.deepEqual(
    JSON.parse(release.body).activeAttempt,
    { runId, attempt },
    "Candidate attempt is no longer admitted",
  );
  return release;
}

export async function requireCurrentRun(env, request, descriptor) {
  const runId = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  positive(runId);
  positive(attempt);
  const run = await request(`/repos/iExalt/paseo/actions/runs/${runId}`);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.repository.id, 1404390841);
  assert.equal(run.repository.full_name, "iExalt/paseo");
  assert.equal(run.repository.private, false);
  assert.equal(run.path, ".github/workflows/release-candidate.yml");
  assert.equal(run.event, env.GITHUB_EVENT_NAME);
  assert.ok(["pull_request_target", "workflow_dispatch"].includes(run.event));
  assert.equal(run.status, "in_progress");
  assert.equal(run.conclusion, null);
  if (run.event === "workflow_dispatch") {
    assert.equal(run.head_sha, env.GITHUB_SHA);
    assert.equal(run.head_branch, "dev");
    assert.equal(run.actor.id, 7889894);
    assert.equal(run.actor.login, "iExalt");
  } else {
    // API pull_requests associations can change after a later PR reuses a
    // branch. Bind the original event instead, keeping controller SHA separate.
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    assert.equal(event.repository.id, 1404390841);
    assert.equal(event.repository.full_name, "iExalt/paseo");
    assert.equal(event.repository.private, false);
    assert.equal(event.action, "closed");
    const pr = event.pull_request;
    assert.equal(pr.state, "closed");
    assert.equal(pr.merged, true);
    assert.equal(pr.number, descriptor.releasePr);
    assert.equal(pr.merge_commit_sha, descriptor.sourceSha);
    assert.equal(env.GITHUB_SHA, pr.merge_commit_sha);
    assert.equal(pr.base.ref, "dev");
    assertReleasePr({ ...pr, state: "open" }, releaseBotIdentity(env), descriptor.headSha);
    assert.equal(run.head_sha, pr.head.sha);
    assert.equal(run.head_branch, pr.head.ref);
  }
  return { runId, attempt, headBranch: run.head_branch, headSha: run.head_sha };
}

export async function admitAttempt(api, descriptor, id, env, request) {
  const { runId, attempt } = await requireCurrentRun(env, request, descriptor);
  assert.deepEqual(await loadDescriptor(api, id), descriptor);
  const release = await eligibleDraft(api, descriptor, id);
  const previous = JSON.parse(release.body).activeAttempt;
  if (previous)
    assert.ok(
      runId > previous.runId || (runId === previous.runId && attempt >= previous.attempt),
      "Cannot regress candidate attempt",
    );
  const body = draftBody(descriptor, "active", { runId, attempt });
  if (release.body !== body) await api.setBody(id, body);
  await requireAttempt(api, descriptor, id, runId, attempt);
}
