import { createHash } from "node:crypto";
import {
  STEP_PROOF_TYPE,
  stepProofSubject,
  replaceStepProofVerifier,
} from "../.github/scripts/step-proof.mjs";

const origin = "https://github.com/iExalt/paseo";

// Shapes a result as `gh attestation verify --format json` returns it after
// Sigstore verification; tests then exercise every claim the verifier checks.
export function signedProof({
  runId,
  attempt,
  slot,
  workflow,
  ref = "refs/heads/dev",
  sourceSha,
  evidence = null,
}) {
  const subject = stepProofSubject(runId, attempt, slot);
  return {
    verificationResult: {
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          {
            name: `paseo-step-proof-${slot}`,
            digest: { sha256: createHash("sha256").update(subject).digest("hex") },
          },
        ],
        predicateType: STEP_PROOF_TYPE,
        predicate: {
          schemaVersion: 1,
          kind: "paseo-step-proof",
          repository: "iExalt/paseo",
          runId,
          attempt,
          slot,
          evidence,
        },
      },
      signature: {
        certificate: {
          issuer: "https://token.actions.githubusercontent.com",
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: origin,
          sourceRepositoryIdentifier: "1404390841",
          runInvocationURI: `${origin}/actions/runs/${runId}/attempts/${attempt}`,
          sourceRepositoryRef: ref,
          buildSignerURI: `${origin}/.github/workflows/${workflow}@${ref}`,
          sourceRepositoryDigest: sourceSha,
          buildSignerDigest: sourceSha,
        },
      },
    },
  };
}

// Serves signed results by subject, as GitHub's attestation store does by digest.
export function installStepProofs(t) {
  const proofs = new Map();
  const restore = replaceStepProofVerifier(
    async (subject) => {
      const results = proofs.get(subject);
      if (!results) throw new Error("No attestation for subject");
      return structuredClone(results);
    },
    async () => {},
  );
  t.after(restore);
  return {
    proofs,
    add(spec) {
      const key = stepProofSubject(spec.runId, spec.attempt, spec.slot);
      proofs.set(key, [...(proofs.get(key) ?? []), signedProof(spec)]);
    },
    remove(spec) {
      proofs.delete(stepProofSubject(spec.runId, spec.attempt, spec.slot));
    },
  };
}
