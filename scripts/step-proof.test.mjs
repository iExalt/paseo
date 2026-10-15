import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import {
  STEP_PROOF_TYPE,
  stepProofSubject,
  replaceStepProofVerifier,
  verifyStepProof,
} from "../.github/scripts/step-proof.mjs";
import { BUILD_CACHE_TYPE } from "../.github/scripts/build-cache-provenance.mjs";
import { signedProof } from "./step-proof-fixture.mjs";

const sha = "c".repeat(40);
const spec = {
  runId: 500,
  attempt: 2,
  slot: "grant-runtime",
  workflow: "candidate-auth.yml",
  ref: "refs/heads/dev",
  sourceSha: sha,
  evidence: { artifactId: 7, artifactDigest: "d".repeat(64) },
};
const expected = { ...spec, evidence: undefined };

function serve(t, respond) {
  const waits = [];
  t.after(replaceStepProofVerifier(respond, async (delay) => waits.push(delay)));
  return waits;
}

test("signed proofs bind the exact attempt, signer workflow, ref and source commit", async (t) => {
  let results;
  serve(t, async () => structuredClone(results));
  results = [signedProof(spec)];
  assert.deepEqual(await verifyStepProof(expected), { evidence: spec.evidence, sourceSha: sha });
  const certificate = (patch) => (result) =>
    Object.assign(result.verificationResult.signature.certificate, patch);
  const statement = (patch) => (result) =>
    Object.assign(result.verificationResult.statement, patch);
  const predicate = (patch) => (result) =>
    Object.assign(result.verificationResult.statement.predicate, patch);
  for (const mutate of [
    certificate({
      runInvocationURI: "https://github.com/iExalt/paseo/actions/runs/500/attempts/1",
    }),
    certificate({
      runInvocationURI: "https://github.com/iExalt/paseo/actions/runs/501/attempts/2",
    }),
    certificate({
      buildSignerURI: "https://github.com/iExalt/paseo/.github/workflows/ci.yml@refs/heads/dev",
    }),
    certificate({ sourceRepositoryRef: "refs/heads/main" }),
    certificate({ sourceRepositoryDigest: "e".repeat(40), buildSignerDigest: "e".repeat(40) }),
    certificate({ buildSignerDigest: "e".repeat(40) }),
    certificate({ runnerEnvironment: "self-hosted" }),
    certificate({ issuer: "https://token.example" }),
    certificate({ sourceRepositoryIdentifier: "1" }),
    certificate({ sourceRepositoryURI: "https://github.com/getpaseo/paseo" }),
    statement({ predicateType: "https://slsa.dev/provenance/v1" }),
    statement({ subject: [{ name: "proof", digest: { sha256: "0".repeat(64) } }] }),
    predicate({ slot: "grant-verification" }),
    predicate({ runId: 501 }),
    predicate({ attempt: 1 }),
    predicate({ repository: "getpaseo/paseo" }),
    predicate({ extra: true }),
  ]) {
    const result = signedProof(spec);
    mutate(result);
    results = [result];
    await assert.rejects(verifyStepProof(expected));
  }
  // One attempt has one slot; a second signed claim must agree exactly.
  results = [signedProof(spec), signedProof({ ...spec, evidence: null })];
  await assert.rejects(verifyStepProof(expected), /Conflicting/);
  results = [signedProof(spec), signedProof(spec)];
  assert.deepEqual((await verifyStepProof(expected)).evidence, spec.evidence);
  // Pull request proofs bind their merge ref; the caller checks the receipt commit.
  const pr = { ...spec, ref: "refs/pull/7/merge", sourceSha: undefined };
  results = [signedProof({ ...pr, sourceSha: sha })];
  assert.equal((await verifyStepProof(pr)).sourceSha, sha);
});

test("verification retries twice, within a fixed bound", async (t) => {
  let calls = 0;
  let fail = 2;
  let empty = false;
  const waits = serve(t, async (subject, request) => {
    calls++;
    assert.equal(subject, stepProofSubject(500, 2, "grant-runtime"));
    assert.equal(request.workflow, "candidate-auth.yml");
    if (fail-- > 0) throw new Error("HTTP 502");
    return empty ? [] : [signedProof(spec)];
  });
  await verifyStepProof(expected);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5000, 10000]);
  calls = 0;
  fail = 3;
  await assert.rejects(verifyStepProof(expected), /did not verify/);
  assert.equal(calls, 3);
  calls = 0;
  fail = 0;
  empty = true;
  await assert.rejects(verifyStepProof(expected), /Missing step proof/);
  assert.equal(calls, 1);
});

test("malformed proof requests fail before any verification", async (t) => {
  let calls = 0;
  serve(t, async () => {
    calls++;
    return [signedProof(spec)];
  });
  for (const patch of [
    { slot: "../grant" },
    { slot: "Grant" },
    { workflow: "../ci.yml" },
    { ref: "refs/heads/main" },
    { runId: 0 },
    { attempt: 1.5 },
    { sourceSha: "c".repeat(39) },
  ])
    await assert.rejects(verifyStepProof({ ...expected, ...patch }));
  assert.equal(calls, 0);
});

const auth = "Authenticate candidate and admitted attempt";
const source = "Read authenticated candidate source";
const artifact = (id) =>
  `format('{{"artifactId":{0},"artifactDigest":"{1}"}}', steps.${id}.outputs.artifact-id, steps.${id}.outputs.artifact-digest)`;
// Each signed slot gates on the steps its verifier previously read from
// GitHub's step records; `#id` names an unnamed step.
const sites = {
  "ci.yml/attest-source": {
    slot: "ci-source-routine",
    gates: [],
    evidence: "needs.plan.outputs.receipt",
  },
  "ci-deep.yml/browser": {
    slot: "ci-source-deep-${{ matrix.lane }}",
    gates: ["Validate exact source and isolated configuration"],
    evidence: "steps.validate.outputs.receipt",
  },
  "candidate-auth.yml/authenticate": {
    slot: "grant-${{ inputs.group }}",
    gates: ["Authenticate current worker phase", "Upload authenticated worker grant"],
    evidence: artifact("upload"),
  },
  "fork-builds.yml/candidate-complete": {
    slot: "paired-manifest",
    gates: [
      auth,
      "Verify both artifacts and write normalized candidate manifest",
      "Upload normalized paired candidate manifest",
    ],
    evidence: artifact("upload-manifest"),
  },
  "macos-closure.yml/build-and-export": {
    slot: "paired-macos-build",
    gates: [
      auth,
      source,
      "Import the pinned Node seed and verify source identity",
      "Build the macOS desktop output",
      "Sign and export the closure",
      "Remove temporary Nix signing key file",
      "Upload public closure and metadata artifact",
    ],
  },
  "macos-closure.yml/verify-import": {
    slot: "paired-macos-import",
    gates: [auth, source, "Import and verify signed closure"],
  },
  "fork-android-apk.yml/sign": {
    slot: "paired-android-sign",
    gates: [
      auth,
      "Sign and verify with the approved fork certificate",
      "Remove signing material",
      "#upload-final",
    ],
  },
  "candidate-runtime.yml/android": {
    slot: "producer-android-arm64",
    gates: [
      auth,
      "Verify signed ARM64 APKs and retained native state",
      "Remove owned Android container after interruption",
    ],
  },
  "candidate-runtime.yml/macos": {
    slot: "producer-macos-arm64",
    gates: [auth, "Verify canonical signed packages and preserved native state"],
  },
  "linux-nix-runtime.yml/native": {
    slot: "producer-linux-nix-${{ inputs.architecture }}",
    gates: [
      auth,
      source,
      "Replace owned Nix profile and verify retained desktop state",
      "Export and verify signed native closures",
      "Remove owned temporary Nix signing key",
      "Transfer immutable candidate closures",
    ],
    evidence: artifact("packages"),
  },
  "linux-product-runtime.yml/native": {
    slot: "producer-linux-products-${{ inputs.architecture }}",
    gates: [
      auth,
      source,
      "Verify installed product upgrades and preserved state",
      "Clean owned installations, containers and state",
      "Export verified candidate packages",
      "Transfer immutable candidate packages",
    ],
    evidence: artifact("packages"),
  },
  "windows-product-runtime.yml/native": {
    slot: "producer-windows-${{ inputs.architecture }}",
    gates: [
      auth,
      source,
      "Verify installed upgrade, retained CLI, PTY and real speech",
      "Reconcile owned processes and remove installation and state",
      "Remove owned build worktrees and isolated storage",
      "Export verified candidate packages",
      "Transfer immutable candidate packages",
    ],
    evidence: artifact("packages"),
    shell: "pwsh",
  },
};

// Build cache archives are attested only by dispatched dev writers: either a
// dispatch-only workflow, or a job whose archive step is guarded off for
// candidate runs by an exact leading conjunction.
const cacheWriters = {
  "windows-product-runtime.yml/native": [
    {
      archive: "modules-archive",
      key: "modules",
      guard: "inputs.architecture == 'arm64' && inputs.source_sha == '' && ",
    },
    { archive: "predecessor-archive", key: "predecessor", guard: "inputs.source_sha == '' && " },
  ],
  "android-build-cache.yml/write": [{ archive: "ccache-archive", key: "ccache" }],
};
function checkCacheSigner(site, workflow, steps, sign) {
  const writer = cacheWriters[site]?.find((entry) => sign.if?.includes(`steps.${entry.archive}.`));
  assert.ok(writer, `${site} attests a build cache outside a known writer`);
  const archive = steps.find((step) => step.id === writer.archive);
  if (writer.guard) {
    assert.ok(archive.if.startsWith(writer.guard), `${site} archives in candidate runs`);
    assert.doesNotMatch(archive.if, /\|\|/, `${site} archive guard has an alternative`);
  } else assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(sign.uses, "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
  assert.equal(sign.if, `steps.${writer.archive}.outcome == 'success'`);
  assert.deepEqual(sign.with, {
    "subject-path": `\${{ steps.${writer.key}.outputs.archive }}`,
    "predicate-type": BUILD_CACHE_TYPE,
    predicate: `\${{ format('{{"schemaVersion":1,"kind":"paseo-build-cache","key":"{0}"}}', steps.${writer.key}.outputs.key) }}`,
    "show-summary": false,
  });
}

test("every signed slot gates on its required step outcomes and nothing else signs", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const found = new Set();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const workflow = load(readFileSync(new URL(file, directory), "utf8"));
    for (const [key, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const index = steps.findIndex((step) => step.id === "proof-subject");
      const cacheSigners = steps.filter(
        (step) =>
          step.uses?.startsWith("actions/attest") &&
          step.with?.["predicate-type"] === BUILD_CACHE_TYPE,
      );
      for (const step of cacheSigners) checkCacheSigner(`${file}/${key}`, workflow, steps, step);
      const signers = steps.filter(
        (step) => step.uses?.startsWith("actions/attest") && !cacheSigners.includes(step),
      );
      if (index < 0) {
        assert.equal(signers.length, 0, `${file}/${key} signs outside a step proof`);
        continue;
      }
      const site = sites[`${file}/${key}`];
      assert.ok(site, `Unexpected step proof in ${file}/${key}`);
      found.add(`${file}/${key}`);
      const subject = steps[index];
      const ids = site.gates.map((gate) => {
        const match = steps
          .slice(0, index)
          .filter((step) =>
            gate.startsWith("#") ? step.id === gate.slice(1) : step.name === gate,
          );
        assert.equal(match.length, 1, `${file}/${key} lacks gate ${gate}`);
        assert.ok(match[0].id, `${file}/${key} gate ${gate} has no id`);
        return match[0].id;
      });
      assert.equal(
        subject.if,
        ids.length ? ids.map((id) => `steps.${id}.outcome == 'success'`).join(" && ") : undefined,
      );
      assert.equal(subject.env.PROOF_SLOT, site.slot);
      assert.equal(subject.shell, site.shell ?? "bash");
      const sign = steps[index + 1];
      assert.deepEqual(signers, [sign]);
      assert.equal(sign.uses, "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
      assert.equal(sign.if, "steps.proof-subject.outcome == 'success'");
      assert.deepEqual(sign.with, {
        "subject-path": "${{ steps.proof-subject.outputs.subject }}",
        "predicate-type": STEP_PROOF_TYPE,
        predicate: `\${{ format('{{"schemaVersion":1,"kind":"paseo-step-proof","repository":"{0}","runId":{1},"attempt":{2},"slot":"{3}","evidence":{4}}}', github.repository, github.run_id, github.run_attempt, steps.proof-subject.outputs.slot, ${site.evidence ?? "'null'"}) }}`,
        "show-summary": false,
      });
      assert.equal(job.permissions["id-token"], "write");
      assert.equal(job.permissions.attestations, "write");
      if (subject.shell === "bash") {
        // The signed subject is the exact text the verifier derives.
        const temp = mkdtempSync(join(tmpdir(), "step-proof-subject-"));
        try {
          execFileSync("bash", ["-euo", "pipefail", "-c", subject.run], {
            env: {
              PATH: process.env.PATH,
              PROOF_SLOT: "grant-runtime",
              RUNNER_TEMP: temp,
              GITHUB_REPOSITORY: "iExalt/paseo",
              GITHUB_RUN_ID: "500",
              GITHUB_RUN_ATTEMPT: "2",
              GITHUB_OUTPUT: join(temp, "output"),
            },
          });
          const output = readFileSync(join(temp, "output"), "utf8");
          const written = output.match(/^subject=(.+)$/m)[1];
          assert.equal(readFileSync(written, "utf8"), stepProofSubject(500, 2, "grant-runtime"));
          assert.match(output, /^slot=grant-runtime$/m);
          assert.throws(() =>
            execFileSync("bash", ["-eo", "pipefail", "-c", subject.run], {
              env: {
                PATH: process.env.PATH,
                PROOF_SLOT: "../x",
                RUNNER_TEMP: temp,
                GITHUB_REPOSITORY: "iExalt/paseo",
                GITHUB_RUN_ID: "500",
                GITHUB_RUN_ATTEMPT: "2",
                GITHUB_OUTPUT: join(temp, "rejected"),
              },
              stdio: "ignore",
            }),
          );
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
      } else {
        assert.match(subject.run, /-cnotmatch '\^\[a-z0-9\]\[a-z0-9-\]\{0,79\}\$'/);
        assert.match(
          subject.run,
          /"paseo-step-proof-v1`n\$env:GITHUB_REPOSITORY`n\$env:GITHUB_RUN_ID`n\$env:GITHUB_RUN_ATTEMPT`n\$env:PROOF_SLOT`n"/,
        );
      }
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(sites).sort());
  const ci = load(readFileSync(new URL("ci.yml", directory), "utf8"));
  assert.equal(ci.jobs["attest-source"].needs, "plan");
  assert.ok(ci.jobs.required.needs.includes("attest-source"));
  assert.match(ci.jobs.required.steps[0].run, /"\$ATTEST_RESULT" = success/);
});
