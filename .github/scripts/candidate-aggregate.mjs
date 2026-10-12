import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readWorkerContext, attemptJobs } from "./candidate-worker.mjs";
import { aggregateCandidate, producerGroups } from "./candidate-matrix.mjs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import {
  attemptAssetName,
  requireCurrentRun,
  requireAttempt,
  uploadAttemptBytes,
} from "./candidate-draft.mjs";
import { readGithub } from "./release-pr-checks.mjs";
import {
  serializeForkReleaseManifest,
  validateForkReleaseManifest,
} from "../../packages/protocol/src/release-manifest-v2.ts";
import { PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL } from "../../packages/protocol/src/release-manifest.ts";
import { validateNixClosureManifest } from "../../scripts/paseo-nix-update.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataLimit = 1024 ** 2;
function asset(release, runId, attempt, name) {
  const matches = release.assets.filter(
    (item) => item.name === attemptAssetName(runId, attempt, name),
  );
  assert.equal(matches.length, 1, `Missing or duplicate current-attempt ${name}`);
  assert.equal(matches[0].state, "uploaded");
  return matches[0];
}

export async function verifyAggregate(
  env = process.env,
  { authenticate = readWorkerContext, request = readGithub, draftApi = candidateGithub } = {},
) {
  assert.equal(
    env.CANDIDATE_NATIVE_ENABLED,
    "true",
    "Native canary cannot produce a complete candidate",
  );
  const context = await authenticate(env);
  const { descriptor, releaseId, runId, attempt } = context;
  const api = draftApi(env.GH_TOKEN);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  const release = await api.get(releaseId);
  const receipts = [];
  for (const group of Object.keys(producerGroups)) {
    const bytes = await api.read(
      asset(release, runId, attempt, `receipts-${group}.json`),
      metadataLimit,
    );
    const values = JSON.parse(bytes);
    assert.ok(Array.isArray(values) && values.length === producerGroups[group].cells.length);
    assert.ok(values.every((receipt) => receipt.group === group));
    receipts.push(...values);
  }
  const jobs = await attemptJobs(context, request);
  for (const job of jobs) {
    assert.equal(job.run_id, runId);
    assert.equal(job.run_attempt, attempt);
  }
  const manifest = aggregateCandidate(descriptor, runId, attempt, receipts, jobs);
  // Re-download every admitted byte from draft storage. Producer-local files or
  // artifact ZIPs cannot substitute for the eventual publication payload.
  for (const entry of manifest.artifacts) {
    await requireCurrentRun(env, request);
    await api.verifyFile(asset(release, runId, attempt, entry.name), entry);
    if (entry.closureManifest) {
      const expected = entry.closureManifest;
      const bytes = await api.read(asset(release, runId, attempt, expected.name), metadataLimit);
      assert.equal(bytes.length, expected.bytes);
      assert.equal(digest(bytes), expected.sha256);
      if (entry.platform === "macos") validateNixClosureManifest(bytes, manifest);
      else {
        const closure = JSON.parse(bytes);
        assert.equal(closure.sourceSha, descriptor.sourceSha);
        assert.equal(closure.treeSha, descriptor.treeSha);
        assert.equal(closure.version, descriptor.version);
        assert.equal(closure.outputPath, entry.outputPath);
        assert.equal(closure.system, entry.system);
      }
    }
  }
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  const bytes = Buffer.from(serializeForkReleaseManifest(manifest));
  const evidence = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: "paseo-complete-candidate",
      descriptorSha256: descriptorDigest(descriptor),
      sourceSha: descriptor.sourceSha,
      runId,
      attempt,
      manifestSha256: digest(bytes),
      receipts,
      verification: jobs
        .filter((job) => job.status === "completed" && job.conclusion === "success")
        .map(({ id, name }) => ({ id, name })),
    }) + "\n",
  );
  assert.ok(evidence.length <= metadataLimit);
  await writeFile(join(env.RUNNER_TEMP, "verified-candidate-manifest.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(env.RUNNER_TEMP, "verified-candidate-evidence.json"), evidence, {
    flag: "wx",
    mode: 0o600,
  });
  await appendFile(
    env.GITHUB_OUTPUT,
    `manifest_digest=${digest(bytes)}\nevidence_digest=${digest(evidence)}\n`,
  );
  return manifest;
}

export async function signAggregate(
  env = process.env,
  {
    authenticate = readWorkerContext,
    request = readGithub,
    draftApi = candidateGithub,
    publicPin = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
  } = {},
) {
  assert.equal(env.CANDIDATE_NATIVE_ENABLED, "true");
  const context = await authenticate(env);
  const { descriptor, releaseId, runId, attempt } = context;
  const api = draftApi(env.GH_TOKEN);
  const bytes = await readFile(join(env.RUNNER_TEMP, "verified-candidate-manifest.json"));
  const evidence = await readFile(join(env.RUNNER_TEMP, "verified-candidate-evidence.json"));
  assert.equal(digest(bytes), env.VERIFIED_MANIFEST_DIGEST);
  assert.equal(digest(evidence), env.VERIFIED_EVIDENCE_DIGEST);
  const proof = JSON.parse(evidence);
  assert.equal(proof.descriptorSha256, descriptorDigest(descriptor));
  assert.equal(proof.runId, runId);
  assert.equal(proof.attempt, attempt);
  assert.equal(proof.manifestSha256, digest(bytes));
  const manifest = JSON.parse(bytes);
  validateForkReleaseManifest(manifest);
  assert.deepEqual(
    aggregateCandidate(
      descriptor,
      runId,
      attempt,
      proof.receipts,
      await attemptJobs(context, request),
    ),
    manifest,
  );
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  const key = createPrivateKey(env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY);
  delete env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY;
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(createPublicKey(key).export({ format: "jwk" }).x, publicPin);
  const signature = Buffer.from(sign(null, bytes, key).toString("base64url"));
  for (const [name, value] of [
    ["paseo-release-manifest.json", bytes],
    ["paseo-release-manifest.sig", signature],
    ["candidate-evidence.json", evidence],
  ]) {
    await requireCurrentRun(env, request);
    await uploadAttemptBytes(api, descriptor, releaseId, runId, attempt, name, value);
  }
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "verify") await verifyAggregate();
  else if (process.argv[2] === "sign") await signAggregate();
  else throw new Error("Expected verify or sign");
}
