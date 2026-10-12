import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseForkVersion,
  forkReleaseTag,
  forkVersionFromTag,
  compareForkVersions,
} from "../../scripts/fork-version.mjs";
import { verifyDescriptor, descriptorDigest, draftTag } from "./candidate-descriptor.mjs";
import { validateDraft } from "./candidate-draft.mjs";
import { assertReleasePr } from "./release-pr.mjs";

export const replacementPath = ".github/pending-candidate-replacement.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unchanged = [
  "package-lock.json",
  "nix/npm-deps.hash",
  ".github/fork-release.json",
  ".release-please-manifest.json",
  ".github/release-boundary.json",
  "release-please-config.json",
  "CHANGELOG.fork.md",
];

export function validateReplacement(record) {
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "authorities",
      "lockSha256",
      "npmDepsHash",
      "repairBase",
      "schemaVersion",
      "supersededPr",
      "supersededSource",
      "version",
    ].sort(),
  );
  assert.equal(record.schemaVersion, 1);
  parseForkVersion(record.version);
  assert.ok(Number.isSafeInteger(record.supersededPr) && record.supersededPr > 0);
  for (const key of ["supersededSource", "repairBase"]) assert.match(record[key], /^[a-f0-9]{40}$/);
  assert.notEqual(record.supersededSource, record.repairBase);
  assert.match(record.lockSha256, /^[a-f0-9]{64}$/);
  assert.match(record.npmDepsHash, /^sha256-[A-Za-z0-9+/]{43}=$/);
  assert.ok(Array.isArray(record.authorities) && record.authorities.length > 0);
  let previousId = 0;
  for (const authority of record.authorities) {
    assert.deepEqual(Object.keys(authority).sort(), ["descriptorSha256", "releaseId"]);
    assert.ok(Number.isSafeInteger(authority.releaseId) && authority.releaseId > previousId);
    assert.match(authority.descriptorSha256, /^[a-f0-9]{64}$/);
    previousId = authority.releaseId;
  }
  return record;
}

export async function replacementTree(record, readBase) {
  validateReplacement(record);
  const lock = await readBase("package-lock.json");
  assert.equal(digest(lock), record.lockSha256);
  assert.equal((await readBase("nix/npm-deps.hash")).trim(), record.npmDepsHash);
  assert.equal(JSON.parse(lock).version, record.version);
  assert.equal(JSON.parse(await readBase(".github/fork-release.json")).version, record.version);
  assert.deepEqual(JSON.parse(await readBase(".release-please-manifest.json")), {
    ".": record.version,
  });
  return new Map([[replacementPath, `${JSON.stringify(record, null, 2)}\n`]]);
}

export async function verifyReplacementTree(record, source, parent, paths, read) {
  validateReplacement(record);
  assert.equal(parent, record.repairBase, "Replacement must have the exact reviewed repair parent");
  assert.notEqual(source, record.supersededSource);
  assert.deepEqual(
    paths,
    [replacementPath],
    "Replacement commit may change only its selection record",
  );
  const expected = await replacementTree(record, (file) => read(parent, file));
  assert.equal(await read(source, replacementPath), expected.get(replacementPath));
  for (const file of unchanged)
    assert.equal(await read(source, file), await read(parent, file), file);
}

// All matching signed authorities, including retired draft tags, participate in
// replacement eligibility. A changed display tag cannot hide a predecessor.
export async function verifyReplacementHistory(record, { api, request, identity, currentSource }) {
  validateReplacement(record);
  const repository = "/repos/iExalt/paseo";
  assert.equal(
    await api.ref(forkReleaseTag(record.version)),
    null,
    "Version already has a final tag",
  );
  const releases = await api.list();
  const authorities = [];
  let predecessor;
  for (const listed of releases) {
    const finalVersion = forkVersionFromTag(listed.tag_name);
    if (finalVersion !== null)
      assert.ok(
        compareForkVersions(finalVersion, record.version) < 0,
        "Version already released or superseded",
      );
    if (
      !listed.tag_name?.startsWith("paseo-retired-candidate-") &&
      !listed.tag_name?.startsWith(`paseo-candidate-v${record.version}-`)
    )
      continue;
    if (currentSource && listed.tag_name === `paseo-candidate-v${record.version}-${currentSource}`)
      continue;
    const release = await api.get(listed.id);
    const asset = (name) => {
      const matches = release.assets.filter((item) => item.name === name);
      assert.equal(matches.length, 1, "Missing or duplicate historical authority");
      return matches[0];
    };
    const bytes = await api.read(asset("candidate-descriptor.json"), 16384);
    const signature = await api.read(asset("candidate-descriptor.sig"), 86);
    const descriptor = verifyDescriptor(bytes, signature.toString("ascii"), api.publicPin);
    assert.ok(
      [draftTag(descriptor), `paseo-retired-candidate-${release.id}`].includes(release.tag_name),
    );
    validateDraft({ ...release, tag_name: draftTag(descriptor) }, descriptor, false);
    if (descriptor.version !== record.version) continue;
    assert.equal(
      JSON.parse(release.body).state,
      "stopped",
      "A predecessor authority remains active",
    );
    if (descriptor.sourceSha === currentSource) continue;
    authorities.push({ releaseId: release.id, descriptorSha256: descriptorDigest(descriptor) });
    if (descriptor.sourceSha === record.supersededSource) {
      assert.equal(descriptor.releasePr, record.supersededPr);
      predecessor = descriptor;
    }
  }
  authorities.sort((left, right) => left.releaseId - right.releaseId);
  assert.deepEqual(authorities, record.authorities, "Historical authority inventory changed");
  assert.ok(predecessor, "Replacement must name an issued predecessor");
  const pr = await request(`${repository}/pulls/${record.supersededPr}`);
  assert.equal(pr.number, record.supersededPr);
  assert.equal(pr.state, "closed");
  assert.equal(pr.merged, true);
  assert.equal(pr.commits, 1);
  assert.equal(pr.merge_commit_sha, record.supersededSource);
  // Both states are allowed only for historical authentication so a lost label
  // response can be reconciled; current candidate checks still require pending.
  assert.ok(
    pr.labels.some((label) =>
      ["autorelease: pending", "autorelease: superseded"].includes(label.name),
    ),
  );
  assertReleasePr(
    { ...pr, state: "open", labels: [{ name: "autorelease: pending" }] },
    identity,
    predecessor.headSha,
  );
  assert.equal(pr.base.ref, "dev");
  const commit = await request(`${repository}/git/commits/${record.supersededSource}`);
  assert.equal(commit.sha, record.supersededSource);
  assert.equal(commit.tree.sha, predecessor.treeSha);
  assert.deepEqual(
    commit.parents.map((parent) => parent.sha),
    [predecessor.baseSha],
  );
  const ancestry = await request(
    `${repository}/compare/${record.supersededSource}...${record.repairBase}`,
  );
  assert.equal(ancestry.base_commit.sha, record.supersededSource);
  assert.ok(["ahead", "identical"].includes(ancestry.status));
  return predecessor;
}

export async function replacementForSource(descriptor, read, request) {
  const parentManifest = JSON.parse(
    await read(descriptor.baseSha, ".release-please-manifest.json"),
  );
  assert.deepEqual(Object.keys(parentManifest), ["."]);
  const order = compareForkVersions(descriptor.version, parentManifest["."]);
  assert.ok(order >= 0, "Candidate version regressed from its parent");
  if (order > 0) return null;
  const record = JSON.parse(await read(descriptor.sourceSha, replacementPath));
  assert.equal(record.version, descriptor.version);
  const diff = await request(
    `/repos/iExalt/paseo/compare/${descriptor.baseSha}...${descriptor.sourceSha}`,
  );
  assert.equal(diff.status, "ahead");
  assert.equal(diff.total_commits, 1);
  assert.equal(diff.base_commit.sha, descriptor.baseSha);
  assert.ok(Array.isArray(diff.files));
  await verifyReplacementTree(
    record,
    descriptor.sourceSha,
    descriptor.baseSha,
    diff.files.map((file) => file.filename),
    read,
  );
  return record;
}
