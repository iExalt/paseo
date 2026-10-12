import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compareForkVersions, forkVersionFromTag } from "../../scripts/fork-version.mjs";
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
export function draftBody(descriptor, state = "active") {
  assert.ok(["active", "stopped"].includes(state));
  return JSON.stringify({
    kind: "paseo-candidate-storage",
    schemaVersion: 1,
    descriptorSha256: descriptorDigest(descriptor),
    state,
  });
}
export function validateDraft(release, descriptor, active = true) {
  validateDescriptor(descriptor);
  positive(release.id);
  assert.equal(release.draft, true, "Candidate storage is no longer a draft");
  assert.equal(release.prerelease, false);
  assert.equal(release.tag_name, draftTag(descriptor));
  assert.equal(release.target_commitish, descriptor.sourceSha);
  assert.equal(release.name, draftTag(descriptor));
  const body = JSON.parse(release.body);
  assert.equal(release.body, draftBody(descriptor, body.state));
  if (active) assert.equal(body.state, "active", "Candidate has stopped");
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
  assert.equal(await api.ref(descriptor.releaseTag), null, "Final tag already exists");
  assert.equal(await api.ref(draftTag(descriptor)), null, "Transport tag already exists");
  const releases = await api.list();
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
      selected = validateDraft(release, descriptor);
    } else if (release.tag_name?.startsWith(`paseo-candidate-v${descriptor.version}-`)) {
      // Replacement authority requires a verifiable stopped predecessor, not a
      // mutable body claiming it stopped or an arbitrary similarly named draft.
      const prior = await loadDescriptor(api, release.id);
      validateDraft(release, prior, false);
      assert.equal(
        JSON.parse(release.body).state,
        "stopped",
        "Another source is active for this version",
      );
    }
  }
  if (existingId !== undefined) {
    assert.equal(selected?.id, existingId, "Candidate draft identity changed");
    return validateDraft(await api.get(existingId), descriptor);
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

async function immutableBytes(api, descriptor, id, name, bytes) {
  const check = async (asset) => {
    assert.equal(asset.state, "uploaded");
    assert.equal(asset.size, bytes.length);
    const actual = await api.read(asset, bytes.length);
    assert.equal(actual.length, bytes.length);
    assert.equal(digest(actual), digest(bytes), "Immutable asset content differs");
    return asset;
  };
  const release = await eligibleDraft(api, descriptor, id);
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) return check(existing);
  try {
    await api.upload(id, name, bytes);
  } catch (error) {
    // A lost response is not permission to overwrite. Reconcile the exact name
    // and bytes before deciding whether the interrupted operation succeeded.
    const reconciled = await eligibleDraft(api, descriptor, id);
    const asset = reconciled.assets.find((item) => item.name === name);
    if (!asset) throw error;
    return check(asset);
  }
  const completed = await eligibleDraft(api, descriptor, id);
  const asset = completed.assets.find((item) => item.name === name);
  assert.ok(asset, "Uploaded asset is absent");
  return check(asset);
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
export async function uploadAttemptBytes(api, descriptor, id, runId, attempt, name, bytes) {
  assert.deepEqual(await loadDescriptor(api, id), descriptor);
  return immutableBytes(api, descriptor, id, attemptAssetName(runId, attempt, name), bytes);
}
