import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const STEP_PROOF_TYPE = "https://github.com/iExalt/paseo/attestations/step-proof/v1";
const repository = "iExalt/paseo";
const origin = `https://github.com/${repository}`;
const predicateKeys = [
  "schemaVersion",
  "kind",
  "repository",
  "runId",
  "attempt",
  "slot",
  "evidence",
];

function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
  return value;
}

export function validateSlot(slot) {
  assert.match(slot, /^[a-z0-9][a-z0-9-]{0,79}$/, "Malformed step proof slot");
  return slot;
}

// The subject names one job slot in one run attempt, so the verifier can
// derive it without trusting logs, artifacts or GitHub's step metadata.
export function stepProofSubject(runId, attempt, slot) {
  return `paseo-step-proof-v1\n${repository}\n${positive(runId)}\n${positive(attempt)}\n${validateSlot(slot)}\n`;
}

function verifyResult(result, expected, digest) {
  const { statement, signature } = result.verificationResult;
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, STEP_PROOF_TYPE);
  assert.equal(statement.subject.length, 1);
  assert.deepEqual(statement.subject[0].digest, { sha256: digest });
  const predicate = statement.predicate;
  assert.deepEqual(Object.keys(predicate).sort(), [...predicateKeys].sort());
  assert.equal(predicate.schemaVersion, 1);
  assert.equal(predicate.kind, "paseo-step-proof");
  assert.equal(predicate.repository, repository);
  assert.equal(predicate.runId, expected.runId);
  assert.equal(predicate.attempt, expected.attempt);
  assert.equal(predicate.slot, expected.slot);
  const certificate = signature.certificate;
  assert.equal(certificate.issuer, "https://token.actions.githubusercontent.com");
  assert.equal(certificate.runnerEnvironment, "github-hosted");
  assert.equal(certificate.sourceRepositoryURI, origin);
  assert.equal(certificate.sourceRepositoryIdentifier, "1404390841");
  assert.equal(
    certificate.runInvocationURI,
    `${origin}/actions/runs/${expected.runId}/attempts/${expected.attempt}`,
    "Step proof belongs to another run attempt",
  );
  assert.equal(certificate.sourceRepositoryRef, expected.ref);
  assert.equal(
    certificate.buildSignerURI,
    `${origin}/.github/workflows/${expected.workflow}@${expected.ref}`,
  );
  assert.match(certificate.sourceRepositoryDigest, /^[a-f0-9]{40}$/);
  assert.equal(certificate.buildSignerDigest, certificate.sourceRepositoryDigest);
  if (expected.sourceSha) assert.equal(certificate.sourceRepositoryDigest, expected.sourceSha);
  return { evidence: predicate.evidence, sourceSha: certificate.sourceRepositoryDigest };
}

export function verifyWithGh(subject, expected) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-step-proof-"));
  try {
    const file = join(directory, "subject");
    writeFileSync(file, subject, { flag: "wx", mode: 0o600 });
    const args = [
      "attestation",
      "verify",
      file,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/.github/workflows/${expected.workflow}`,
      "--source-ref",
      expected.ref,
      "--predicate-type",
      STEP_PROOF_TYPE,
      "--deny-self-hosted-runners",
      "--format",
      "json",
      ...(expected.sourceSha ? ["--source-digest", expected.sourceSha] : []),
    ];
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let verifier = verifyWithGh;
let pause = sleep;
// Tests substitute signed results; production always verifies through gh.
export function replaceStepProofVerifier(verify, wait = pause) {
  const previous = [verifier, pause];
  [verifier, pause] = [verify, wait];
  return () => {
    [verifier, pause] = previous;
  };
}

// A proof is signed only after its gating steps succeed. The Sigstore
// certificate binds it to the exact run attempt, workflow and source commit.
export async function verifyStepProof(expected) {
  positive(expected.runId);
  positive(expected.attempt);
  validateSlot(expected.slot);
  assert.match(expected.workflow, /^[a-z0-9-]+\.yml$/);
  assert.match(expected.ref, /^refs\/(?:heads\/dev|pull\/[1-9][0-9]*\/merge)$/);
  if (expected.sourceSha) assert.match(expected.sourceSha, /^[a-f0-9]{40}$/);
  const subject = stepProofSubject(expected.runId, expected.attempt, expected.slot);
  const digest = createHash("sha256").update(subject).digest("hex");
  let results, failure;
  // Any failure retries twice; only returned results are trusted, after full checks.
  for (let attempt = 0; attempt < 3 && !results; attempt++) {
    if (attempt) await pause(attempt * 5000);
    try {
      results = await verifier(subject, expected);
    } catch (error) {
      failure = error;
    }
  }
  if (!results) throw new Error(`Step proof ${expected.slot} did not verify`, { cause: failure });
  assert.ok(Array.isArray(results) && results.length > 0, "Missing step proof");
  const proofs = results.map((result) => verifyResult(result, expected, digest));
  for (const proof of proofs.slice(1))
    assert.deepEqual(proof, proofs[0], "Conflicting step proofs for one slot");
  return proofs[0];
}

// Candidate jobs all execute the controller commit on dev, including nested
// reusable workflows, so that commit is the signer digest for every slot.
export function verifyCandidateProof(context, slot, workflow) {
  return verifyStepProof({
    runId: context.runId,
    attempt: context.attempt,
    slot,
    workflow,
    ref: "refs/heads/dev",
    sourceSha: context.controllerSha,
  });
}

export function artifactEvidence(evidence, artifact) {
  assert.deepEqual(Object.keys(evidence ?? {}).sort(), ["artifactDigest", "artifactId"]);
  assert.equal(evidence.artifactId, Number(artifact.id), "Proof names another artifact");
  assert.equal(evidence.artifactDigest, artifact.digest, "Proof names other artifact bytes");
  return evidence;
}
