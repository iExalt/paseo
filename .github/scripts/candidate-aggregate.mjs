import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTrustedWorkerContext, attemptJobs } from "./candidate-worker.mjs";
import { aggregateCandidate, producerGroups } from "./candidate-matrix.mjs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import {
  attemptAssetName,
  requireCurrentRun,
  requireAttempt,
  attemptWriter,
} from "./candidate-draft.mjs";
import { readGithub } from "./release-pr-checks.mjs";
import { attemptLedger } from "./candidate-attempts.mjs";
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
  assert.equal(matches.length, 1, `Missing or duplicate attempt ${attempt} ${name}`);
  assert.equal(matches[0].state, "uploaded");
  return matches[0];
}

// Sequential downloads put about four minutes on the critical path; a few at a
// time stays well inside GitHub's download limits.
const downloadConcurrency = 4;

// Stops scheduling after the first failure and rethrows it once in-flight work
// settles, so no download outlives the verdict.
export async function eachBounded(items, limit, action) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await action(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

const storageOf = (transfers) =>
  Object.fromEntries(Object.entries(transfers).map(([group, item]) => [group, item.attempt]));

export function transferJob(group) {
  assert.ok(Object.hasOwn(producerGroups, group));
  const caller = { "macos-arm64": "transfer-macos", "android-arm64": "transfer-android" }[group];
  return `${caller ?? `transfer-${group}`} / transfer`;
}

// Each group's draft assets come from the transfer execution that last ran, and
// its receipts from the producer execution that last ran; after "Re-run failed
// jobs" either may predate the aggregating attempt.
export async function resolveGroups(context, request) {
  const ledger = attemptLedger(context, request);
  const producers = {};
  const transfers = {};
  for (const group of Object.keys(producerGroups)) {
    producers[group] = await ledger.producer(producerGroups[group].job);
    transfers[group] = await ledger.producer(transferJob(group));
    assert.ok(
      transfers[group].attempt >= producers[group].attempt,
      "Transfer predates its producer execution",
    );
  }
  return { producers, transfers };
}

export async function verifyAggregate(
  env = process.env,
  {
    authenticate = readTrustedWorkerContext,
    request = readGithub,
    draftApi = candidateGithub,
  } = {},
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
  const { producers, transfers } = await resolveGroups(context, request);
  const receipts = [];
  const stored = new Map();
  for (const group of Object.keys(producerGroups)) {
    const bytes = await api.read(
      asset(release, runId, transfers[group].attempt, `receipts-${group}.json`),
      metadataLimit,
    );
    const values = JSON.parse(bytes);
    assert.ok(Array.isArray(values) && values.length === producerGroups[group].cells.length);
    assert.ok(values.every((receipt) => receipt.group === group));
    for (const receipt of values) stored.set(receipt.artifact.name, transfers[group].attempt);
    receipts.push(...values);
  }
  const jobs = await attemptJobs(context, request);
  for (const job of jobs) {
    assert.equal(job.run_id, runId);
    assert.equal(job.run_attempt, attempt);
  }
  const manifest = aggregateCandidate(descriptor, runId, receipts, jobs, producers);
  // Re-download every admitted byte from draft storage. Producer-local files or
  // artifact ZIPs cannot substitute for the eventual publication payload.
  const largestFirst = manifest.artifacts.toSorted((a, b) => b.bytes - a.bytes);
  await eachBounded(largestFirst, downloadConcurrency, async (entry) => {
    const storedIn = stored.get(entry.name);
    await requireCurrentRun(env, request, context.descriptor);
    await api.verifyFile(asset(release, runId, storedIn, entry.name), entry);
    if (entry.closureManifest) {
      const expected = entry.closureManifest;
      const bytes = await api.read(asset(release, runId, storedIn, expected.name), metadataLimit);
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
  });
  await requireCurrentRun(env, request, context.descriptor);
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
      storage: storageOf(transfers),
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
    authenticate = readTrustedWorkerContext,
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
  const { producers, transfers } = await resolveGroups(context, request);
  assert.deepEqual(proof.storage, storageOf(transfers), "Draft storage changed after verification");
  assert.deepEqual(
    aggregateCandidate(
      descriptor,
      runId,
      proof.receipts,
      await attemptJobs(context, request),
      producers,
    ),
    manifest,
  );
  await requireCurrentRun(env, request, context.descriptor);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  const key = createPrivateKey(env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY);
  delete env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY;
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(createPublicKey(key).export({ format: "jwk" }).x, publicPin);
  const signature = Buffer.from(sign(null, bytes, key).toString("base64url"));
  const writer = await attemptWriter(api, descriptor, releaseId, runId, attempt);
  for (const [name, value] of [
    ["paseo-release-manifest.json", bytes],
    ["paseo-release-manifest.sig", signature],
    ["candidate-evidence.json", evidence],
  ]) {
    await requireCurrentRun(env, request, context.descriptor);
    await writer.bytes(name, value);
  }
  await requireCurrentRun(env, request, context.descriptor);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
}

// The draft has no final state: a later rerun of any producer re-executes the
// aggregate and supersedes the signed payload. Publication therefore reads the
// draft afresh, binds the evidence to the signed manifest bytes, and recomputes
// every group against the run's latest attempt.
export async function verifyPublishable(api, releaseId, request = readGithub) {
  const release = await api.get(releaseId);
  const { runId, attempt } = JSON.parse(release.body).activeAttempt;
  const read = (name) => api.read(asset(release, runId, attempt, name), metadataLimit);
  const evidence = JSON.parse(await read("candidate-evidence.json"));
  assert.equal(evidence.kind, "paseo-complete-candidate");
  assert.equal(evidence.manifestSha256, digest(await read("paseo-release-manifest.json")));
  assert.equal(evidence.runId, runId);
  assert.equal(evidence.attempt, attempt, "A later attempt superseded the signed candidate");
  const run = await request(`/repos/iExalt/paseo/actions/runs/${runId}`);
  assert.equal(run.id, runId);
  assert.equal(run.status, "completed");
  const latest = { runId, attempt: run.run_attempt };
  const ledger = attemptLedger(latest, request);
  assert.equal(
    (await ledger.producer("aggregate")).attempt,
    attempt,
    "The signed aggregate is not the run's latest execution",
  );
  const { producers, transfers } = await resolveGroups(latest, request);
  assert.deepEqual(evidence.storage, storageOf(transfers), "Draft storage changed after signing");
  for (const receipt of evidence.receipts) {
    assert.equal(receipt.attempt, producers[receipt.group].attempt);
    assert.equal(receipt.producerJobId, producers[receipt.group].job.id);
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "verify") await verifyAggregate();
  else if (process.argv[2] === "sign") await signAggregate();
  else if (process.argv[2] === "publishable") {
    await verifyPublishable(candidateGithub(process.env.GH_TOKEN), Number(process.argv[3]));
    process.stdout.write("Signed candidate is the run's latest execution\n");
  } else throw new Error("Expected verify, sign or publishable");
}
