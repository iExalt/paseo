import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { fileIdentity, packageLimit } from "./candidate-files.mjs";
import { producerGroups, validateCellReceipt, verifyProducerJob } from "./candidate-matrix.mjs";
import { githubResponse, saveDownload, validateArtifact } from "./candidate-artifacts.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import {
  requireCurrentRun,
  requireAttempt,
  uploadAttemptFile,
  uploadAttemptBytes,
} from "./candidate-draft.mjs";
import { readGithub } from "./release-pr-checks.mjs";
import { readWorkerContext, attemptJobs } from "./candidate-worker.mjs";

const metadataLimit = 1024 * 1024;
const extractor = fileURLToPath(new URL("./extract-candidate-artifact.py", import.meta.url));
function exact(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
export function productContract(descriptor, group) {
  assert.match(group, /^(?:linux-products|windows)-(?:x64|arm64)$/);
  return producerGroups[group].cells.map((cell) => {
    const [platform, arch, kind] = cell.split("/");
    const extension = { appimage: "AppImage", nsis: "exe" }[kind] ?? kind;
    return {
      cell,
      platform,
      arch,
      kind,
      name: `paseo-${descriptor.version}-${platform}-${arch}.${extension}`,
    };
  });
}

export function productProducer(context, group, jobs, artifact, expected) {
  const contracts = productContract(context.descriptor, group);
  const matches = jobs.filter((job) => job.name === producerGroups[group].job);
  assert.equal(matches.length, 1, "Missing or duplicate native producer");
  const job = matches[0];
  verifyProducerJob({ group, producerJobId: job.id }, jobs);
  assert.equal(job.run_id, context.runId);
  assert.equal(job.run_attempt, context.attempt);
  const linux = group.startsWith("linux-");
  const names = [
    "Authenticate candidate and admitted attempt",
    "Read authenticated candidate source",
    linux
      ? "Verify installed product upgrades and preserved state"
      : "Verify installed upgrade, retained CLI, PTY and real speech",
    linux
      ? "Clean owned installations, containers and state"
      : "Reconcile owned processes and remove installation and state",
    "Export verified candidate packages",
    "Transfer immutable candidate packages",
  ];
  let number = 0,
    completed = Date.parse(job.started_at);
  for (const name of names) {
    const steps = job.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1, `Missing or duplicate ${name}`);
    const step = steps[0];
    assert.equal(step.status, "completed");
    assert.equal(step.conclusion, "success");
    assert.ok(step.number > number);
    assert.ok(Date.parse(step.started_at) >= completed);
    assert.ok(Date.parse(step.completed_at) >= Date.parse(step.started_at));
    number = step.number;
    completed = Date.parse(step.completed_at);
  }
  assert.ok(Date.parse(job.completed_at) >= completed);
  const { platform, arch } = contracts[0];
  const name = `candidate-${platform}-products-${arch}-${context.runId}-${context.attempt}`;
  validateArtifact(
    artifact,
    { runId: context.runId, sourceSha: context.controllerSha },
    { ...expected, name },
    contracts.length * packageLimit + metadataLimit * 2,
  );
  assert.equal(artifact.workflow_run.repository_id, 1404390841);
  assert.equal(artifact.workflow_run.head_repository_id, 1404390841);
  const upload = job.steps.find((step) => step.name === names.at(-1));
  assert.ok(Date.parse(artifact.created_at) >= Date.parse(upload.started_at));
  assert.ok(Date.parse(artifact.created_at) <= Date.parse(upload.completed_at));
  return job.id;
}

export function productReceipts(bundle, context, group, producerJobId) {
  exact(bundle, [
    "schemaVersion",
    "kind",
    "descriptorSha256",
    "sourceSha",
    "treeSha",
    "version",
    "runId",
    "attempt",
    "group",
    "artifacts",
  ]);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.kind, "paseo-candidate-products");
  for (const key of ["sourceSha", "treeSha", "version"])
    assert.equal(bundle[key], context.descriptor[key]);
  assert.equal(bundle.descriptorSha256, descriptorDigest(context.descriptor));
  assert.equal(bundle.runId, context.runId);
  assert.equal(bundle.attempt, context.attempt);
  assert.equal(bundle.group, group);
  const contracts = productContract(context.descriptor, group);
  assert.equal(bundle.artifacts.length, contracts.length);
  return contracts.map(({ cell, ...identity }) => {
    const matches = bundle.artifacts.filter((entry) => entry.name === identity.name);
    assert.equal(matches.length, 1, "Missing or duplicate product bytes");
    const artifact = matches[0];
    exact(artifact, ["name", "platform", "arch", "kind", "sha256", "bytes"]);
    for (const key of Object.keys(identity)) assert.equal(artifact[key], identity[key]);
    fileIdentity(artifact);
    return validateCellReceipt(
      {
        schemaVersion: 1,
        kind: "paseo-candidate-cell",
        descriptorSha256: bundle.descriptorSha256,
        sourceSha: bundle.sourceSha,
        treeSha: bundle.treeSha,
        version: bundle.version,
        runId: bundle.runId,
        attempt: bundle.attempt,
        group,
        producerJobId,
        cell,
        artifact,
        runtime: { passed: true, cleanup: true, signature: "not-applicable" },
      },
      context.descriptor,
      context.runId,
      context.attempt,
    );
  });
}

export async function transferProducts(
  env = process.env,
  {
    authenticate = readWorkerContext,
    request = readGithub,
    response = githubResponse,
    draftApi = candidateGithub,
  } = {},
) {
  const context = await authenticate(env);
  const { descriptor, releaseId, runId, attempt } = context;
  const group = env.CANDIDATE_PRODUCT_GROUP;
  const contracts = productContract(descriptor, group);
  const expected = { id: Number(env.CANDIDATE_ARTIFACT_ID), digest: env.CANDIDATE_ARTIFACT_DIGEST };
  assert.ok(Number.isSafeInteger(expected.id) && expected.id > 0);
  const artifact = await request(`/repos/iExalt/paseo/actions/artifacts/${expected.id}`);
  const producerJobId = productProducer(
    context,
    group,
    await attemptJobs(context, request),
    artifact,
    expected,
  );
  const directory = join(env.RUNNER_TEMP, `candidate-transfer-${group}-${runId}-${attempt}`);
  await mkdir(directory);
  const zip = join(directory, "products.zip");
  const expandedLimit = contracts.length * packageLimit + metadataLimit;
  await saveDownload(
    await response(`actions/artifacts/${expected.id}/zip`, env.GH_TOKEN),
    zip,
    expandedLimit + metadataLimit,
    artifact.size_in_bytes,
    expected.digest,
  );
  const extracted = join(directory, "products");
  execFileSync(
    "python3",
    [
      extractor,
      zip,
      extracted,
      String(expandedLimit),
      JSON.stringify(["candidate-products.json", ...contracts.map(({ name }) => name)]),
    ],
    { timeout: 120000, stdio: "pipe" },
  );
  const metadata = join(extracted, "candidate-products.json");
  assert.ok((await stat(metadata)).size <= metadataLimit);
  const receipts = productReceipts(
    JSON.parse(await readFile(metadata, "utf8")),
    context,
    group,
    producerJobId,
  );
  const api = draftApi(env.GH_TOKEN);
  for (const receipt of receipts) {
    await requireCurrentRun(env, request);
    await uploadAttemptFile(
      api,
      descriptor,
      releaseId,
      runId,
      attempt,
      receipt.artifact.name,
      join(extracted, receipt.artifact.name),
      receipt.artifact,
    );
  }
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  await uploadAttemptBytes(
    api,
    descriptor,
    releaseId,
    runId,
    attempt,
    `receipts-${group}.json`,
    Buffer.from(JSON.stringify(receipts) + "\n"),
  );
  await requireCurrentRun(env, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await transferProducts();
