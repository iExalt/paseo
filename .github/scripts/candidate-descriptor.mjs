import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { forkReleaseTag } from "../../scripts/fork-version.mjs";
import { validateForkConfig } from "../../scripts/fork-release-config.mjs";
import {
  FORK_RELEASE_CELLS,
  FORK_RELEASE_LINEAGE,
} from "../../packages/protocol/src/release-manifest-v2.ts";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
} from "../../packages/protocol/src/release-manifest.ts";

const sha = /^[a-f0-9]{40}$/;
const domain = Buffer.from("paseo-candidate-descriptor-v1\n");
const keys = [
  "schemaVersion",
  "kind",
  "keyId",
  "policy",
  "repository",
  "lineage",
  "version",
  "releaseTag",
  "sourceSha",
  "upstreamBase",
  "treeSha",
  "releasePr",
  "headSha",
  "baseSha",
  "cells",
  "checks",
];
export const sourceGateFiles = Object.freeze([
  ".github/workflows/release-candidate.yml",
  ".github/workflows/candidate-verify.yml",
  ".github/workflows/linux-product-runtime.yml",
  ".github/workflows/windows-product-runtime.yml",
  ".github/scripts/candidate-product-export.mjs",
  ".github/scripts/native-candidate-authority.mjs",
  ".github/scripts/linux-predecessor-cache.mjs",
  ".github/scripts/windows-predecessor-cache.mjs",
  ".github/scripts/linux-product-build.sh",
  ".github/scripts/linux-product-cleanup.sh",
  ".github/scripts/linux-product-package.mjs",
  ".github/scripts/linux-product-runtime.sh",
  ".github/scripts/linux-product-stage.mjs",
  ".github/scripts/linux-product-state-cleanup.mjs",
  ".github/scripts/linux-product-temp.mjs",
  ".github/scripts/windows-product-build.mjs",
  ".github/scripts/windows-product-runtime.mjs",
  ".github/scripts/windows-product-runtime.ps1",
  ".github/scripts/windows-product-stage.ps1",
  ".github/scripts/candidate-entry.mjs",
  ".github/scripts/candidate-authority.mjs",
  ".github/scripts/candidate-draft.mjs",
  ".github/scripts/candidate-github.mjs",
  ".github/scripts/candidate-files.mjs",
  ".github/scripts/candidate-worker.mjs",
  ".github/scripts/candidate-matrix.mjs",
  ".github/scripts/ci-routine.mjs",
  ".github/scripts/ci-deep.mjs",
  ".github/scripts/deep-cleanup.mjs",
  ".github/scripts/candidate-identity.mjs",
  ".github/scripts/candidate-descriptor.mjs",
  ".github/scripts/release-pr-checks.mjs",
  ".github/scripts/ci-source-receipt.mjs",
  ".github/scripts/release-pr.mjs",
  ".github/scripts/release-app-auth.mjs",
  "scripts/fork-release-config.mjs",
  "scripts/fork-version.mjs",
  "packages/protocol/src/fork-version.ts",
  "packages/protocol/src/release-manifest-v2.ts",
  "packages/protocol/src/release-manifest.ts",
]);
export async function sourceGatePolicy(sourceSha, read) {
  assert.match(sourceSha, sha);
  const hash = createHash("sha256");
  for (const file of sourceGateFiles) {
    const bytes = Buffer.from(await read(file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return { version: 1, sourceSha, sha256: hash.digest("hex") };
}
function exact(value, names) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
}

export function validateDescriptor(value) {
  exact(value, keys);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, "paseo-release-candidate");
  assert.equal(value.keyId, PASEO_RELEASE_MANIFEST_KEY_ID);
  exact(value.policy, ["version", "sourceSha", "sha256"]);
  assert.equal(value.policy.version, 1);
  assert.match(value.policy.sourceSha, sha);
  assert.match(value.policy.sha256, /^[a-f0-9]{64}$/);
  assert.equal(value.repository, "iExalt/paseo");
  assert.equal(value.lineage, FORK_RELEASE_LINEAGE);
  assert.equal(value.releaseTag, forkReleaseTag(value.version));
  for (const key of ["sourceSha", "upstreamBase", "treeSha", "headSha", "baseSha"])
    assert.match(value[key], sha);
  positive(value.releasePr);
  assert.deepEqual(value.cells, FORK_RELEASE_CELLS);
  assert.equal(value.checks.length, 2);
  value.checks.forEach((check, index) => {
    exact(check, ["workflow", "runId", "attempt"]);
    assert.equal(check.workflow, ["ci.yml", "ci-deep.yml"][index]);
    positive(check.runId);
    positive(check.attempt);
  });
  return value;
}

export function descriptorFromProof(proof, fork, policy) {
  validateForkConfig(fork);
  return validateDescriptor({
    schemaVersion: 1,
    kind: "paseo-release-candidate",
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    policy,
    repository: fork.repository,
    lineage: fork.lineage,
    version: fork.version,
    releaseTag: forkReleaseTag(fork.version),
    sourceSha: proof.sourceSha,
    upstreamBase: fork.upstreamBase,
    treeSha: proof.treeSha,
    releasePr: proof.number,
    headSha: proof.headSha,
    baseSha: proof.baseSha,
    cells: [...FORK_RELEASE_CELLS],
    checks: proof.proofs.map(({ workflow, runId, attempt }) => ({
      workflow,
      runId,
      attempt,
    })),
  });
}

export function descriptorBytes(value) {
  validateDescriptor(value);
  const canonical = Object.fromEntries(
    keys.map((key) => {
      if (key === "checks")
        return [
          key,
          value.checks.map(({ workflow, runId, attempt }) => ({
            workflow,
            runId,
            attempt,
          })),
        ];
      if (key === "policy")
        return [
          key,
          {
            version: value.policy.version,
            sourceSha: value.policy.sourceSha,
            sha256: value.policy.sha256,
          },
        ];
      return [key, value[key]];
    }),
  );
  return Buffer.from(JSON.stringify(canonical) + "\n");
}
export function descriptorDigest(value) {
  return createHash("sha256").update(descriptorBytes(value)).digest("hex");
}
export function draftTag(value) {
  validateDescriptor(value);
  return `paseo-candidate-v${value.version}-${value.sourceSha}`;
}

// Separate signature domain: a candidate authorization is never a release manifest.
export function signDescriptor(
  value,
  privatePem,
  pin = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  const key = createPrivateKey(privatePem);
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(
    createPublicKey(key).export({ format: "jwk" }).x,
    pin,
    "Candidate signer differs from pinned key",
  );
  return sign(null, Buffer.concat([domain, descriptorBytes(value)]), key).toString("base64url");
}
export function verifyDescriptor(
  bytes,
  signature,
  pin = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  assert.ok(bytes.length > 0 && bytes.length <= 16384);
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pin },
    format: "jwk",
  });
  assert.ok(
    verify(null, Buffer.concat([domain, bytes]), key, Buffer.from(signature, "base64url")),
    "Candidate signature invalid",
  );
  const value = validateDescriptor(JSON.parse(bytes.toString("utf8")));
  assert.ok(descriptorBytes(value).equals(bytes), "Candidate encoding is not canonical");
  return value;
}
