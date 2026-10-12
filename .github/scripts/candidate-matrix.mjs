import assert from "node:assert/strict";
import { descriptorDigest, validateDescriptor } from "./candidate-descriptor.mjs";
import { validateForkReleaseManifest } from "../../packages/protocol/src/release-manifest-v2.ts";
import { PASEO_RELEASE_MANIFEST_KEY_ID } from "../../packages/protocol/src/release-manifest.ts";
import { lanes } from "./ci-routine.mjs";

export const verificationJobs = Object.freeze([
  ...lanes.map((lane) => `verify / routine (${lane})`),
  ...["browser", "integration", "electron"].map((lane) => `verify / deep (${lane})`),
]);

export const producerGroups = Object.freeze({
  "macos-arm64": { job: "native-runtime / macos", cells: ["macos/arm64/nix-desktop"] },
  "android-arm64": { job: "native-runtime / android", cells: ["android/arm64/apk"] },
  "linux-nix-x64": {
    job: "linux-nix (x64) / native",
    cells: ["linux/x64/nix-daemon", "linux/x64/nix-desktop"],
  },
  "linux-nix-arm64": {
    job: "linux-nix (arm64) / native",
    cells: ["linux/arm64/nix-daemon", "linux/arm64/nix-desktop"],
  },
  "linux-products-x64": {
    job: "linux-products (x64) / native",
    cells: ["linux/x64/deb", "linux/x64/rpm", "linux/x64/appimage"],
  },
  "linux-products-arm64": {
    job: "linux-products (arm64) / native",
    cells: ["linux/arm64/deb", "linux/arm64/rpm", "linux/arm64/appimage"],
  },
  "windows-x64": { job: "windows (x64) / native", cells: ["windows/x64/nsis"] },
  "windows-arm64": { job: "windows (arm64) / native", cells: ["windows/arm64/nsis"] },
});
function exact(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
}

export function validateCellReceipt(receipt, descriptor, runId, attempt) {
  validateDescriptor(descriptor);
  exact(receipt, [
    "schemaVersion",
    "kind",
    "descriptorSha256",
    "sourceSha",
    "treeSha",
    "version",
    "runId",
    "attempt",
    "group",
    "producerJobId",
    "cell",
    "artifact",
    "runtime",
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "paseo-candidate-cell");
  assert.equal(receipt.descriptorSha256, descriptorDigest(descriptor));
  assert.equal(receipt.sourceSha, descriptor.sourceSha);
  assert.equal(receipt.treeSha, descriptor.treeSha);
  assert.equal(receipt.version, descriptor.version);
  positive(runId);
  positive(attempt);
  positive(receipt.producerJobId);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.attempt, attempt);
  const group = producerGroups[receipt.group];
  assert.ok(group && group.cells.includes(receipt.cell));
  assert.equal(
    receipt.cell,
    `${receipt.artifact.platform}/${receipt.artifact.arch}/${receipt.artifact.kind}`,
  );
  exact(receipt.runtime, ["passed", "cleanup", "signature"]);
  assert.equal(receipt.runtime.passed, true);
  assert.equal(receipt.runtime.cleanup, true);
  let signature = "not-applicable";
  if (receipt.artifact.kind.startsWith("nix-")) signature = "nix-pinned";
  if (receipt.artifact.kind === "apk") signature = "android-pinned";
  assert.equal(receipt.runtime.signature, signature);
  return receipt;
}

// API provenance is supplied by the controller's fresh run-attempt jobs response,
// never by fields asserted inside a producer-controlled bundle.
export function verifyProducerJob(receipt, jobs) {
  const matches = jobs.filter((job) => job.id === receipt.producerJobId);
  assert.equal(matches.length, 1, "Missing or duplicate producer job");
  const job = matches[0];
  assert.equal(job.name, producerGroups[receipt.group].job);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  assert.equal(jobs.filter((item) => item.name === job.name).length, 1, "Ambiguous producer name");
}

export function aggregateCandidate(descriptor, runId, attempt, receipts, jobs) {
  validateDescriptor(descriptor);
  for (const name of verificationJobs) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate ${name}`);
    assert.equal(matches[0].status, "completed");
    assert.equal(matches[0].conclusion, "success");
  }
  assert.equal(receipts.length, descriptor.cells.length, "Incomplete candidate matrix");
  const remaining = new Set(descriptor.cells);
  for (const receipt of receipts) {
    validateCellReceipt(receipt, descriptor, runId, attempt);
    assert.ok(remaining.delete(receipt.cell), "Duplicate or unexpected candidate cell");
    verifyProducerJob(receipt, jobs);
  }
  assert.equal(remaining.size, 0);
  const manifest = {
    schemaVersion: 2,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    repository: descriptor.repository,
    lineage: descriptor.lineage,
    version: descriptor.version,
    sourceSha: descriptor.sourceSha,
    upstreamBase: descriptor.upstreamBase,
    releaseTag: descriptor.releaseTag,
    artifacts: receipts
      .toSorted((a, b) => a.cell.localeCompare(b.cell))
      .map((receipt) => receipt.artifact),
  };
  validateForkReleaseManifest(manifest);
  return manifest;
}
