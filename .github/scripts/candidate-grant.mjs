import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { descriptorBytes, verifyDescriptor } from "./candidate-descriptor.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import { requireAttempt } from "./candidate-draft.mjs";
import { attemptJobs, readTrustedWorkerContext } from "./candidate-worker.mjs";
import { githubResponse, saveDownload, validateArtifact } from "./candidate-artifacts.mjs";
import { artifactEvidence, verifyCandidateProof } from "./step-proof.mjs";

const paired = "paired / ";
const mac = `${paired}Build and verify macOS closure / `;
const android = `${paired}Build and sign Android APK / `;
export const grantGroups = {
  verification: {
    job: "verify / authorize / authenticate",
    workers: [
      ...["quality", "workspaces", "app", "server-1", "server-2", "server-3", "integration"].map(
        (lane) => `verify / routine (${lane})`,
      ),
      ...["browser", "integration", "electron"].map((lane) => `verify / deep (${lane})`),
    ],
  },
  "paired-identity": {
    job: `${paired}authorize / authenticate`,
    workers: [`${paired}Pin paired build identity`],
  },
  "paired-complete": {
    job: `${paired}authorize-complete / authenticate`,
    workers: [`${paired}Cross-check paired candidate artifacts`],
  },
  "mac-build": {
    job: `${mac}authorize / authenticate`,
    workers: [`${mac}Build and sign macOS closure`],
  },
  "mac-import": {
    job: `${mac}authorize-import / authenticate`,
    workers: [`${mac}Verify closure on a fresh runner`],
  },
  "android-build": {
    job: `${android}authorize / authenticate`,
    workers: [`${android}Build fork arm64 APK`],
  },
  "android-sign": {
    job: `${android}authorize-sign / authenticate`,
    workers: [`${android}Sign and publish fork APK artifact`],
  },
  runtime: {
    job: "native-runtime / authorize / authenticate",
    workers: ["native-runtime / android", "native-runtime / macos"],
  },
};
for (const kind of ["linux-nix", "linux-products", "windows"])
  for (const arch of ["x64", "arm64"])
    grantGroups[`${kind}-${arch}`] = {
      job: `${kind} (${arch}) / authorize / authenticate`,
      workers: [`${kind} (${arch}) / native`],
    };

export function grantName(group, runId, attempt) {
  assert.ok(Object.hasOwn(grantGroups, group), "Unknown authentication group");
  return `candidate-grant-${group}-${runId}-${attempt}`;
}

export async function validateGrant(grant, context, group, worker, jobs, pin, artifact) {
  assert.equal(grant.kind, "paseo-worker-grant");
  assert.equal(grant.schemaVersion, 1);
  assert.equal(grant.group, group);
  assert.deepEqual(grant.context, context);
  const expected = grantGroups[group];
  assert.ok(expected, "Unknown authentication group");
  assert.deepEqual(grant.workers, expected.workers);
  assert.ok(expected.workers.includes(worker), "Worker outside grant scope");
  assert.deepEqual(
    verifyDescriptor(Buffer.from(grant.descriptor), grant.signature, pin),
    context.descriptor,
  );
  const matches = jobs.filter((job) => job.name === expected.job);
  assert.equal(matches.length, 1, "Missing or duplicate authentication job");
  const job = matches[0];
  assert.equal(job.id, grant.authenticationJobId);
  assert.equal(job.run_id, context.runId);
  assert.equal(job.run_attempt, context.attempt);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  const proof = await verifyCandidateProof(context, `grant-${group}`, "candidate-auth.yml");
  artifactEvidence(proof.evidence, artifact);
}

export async function downloadGrant(env, request = fetch) {
  const id = env.CANDIDATE_GRANT_ID;
  assert.match(id, /^[1-9]\d*$/);
  const directory = await mkdtemp(join(env.RUNNER_TEMP, "candidate-grant-"));
  try {
    const metadata = await (
      await githubResponse(`actions/artifacts/${id}`, env.GH_TOKEN, request)
    ).json();
    const runId = Number(env.GITHUB_RUN_ID),
      attempt = Number(env.GITHUB_RUN_ATTEMPT);
    const name = grantName(env.CANDIDATE_GRANT_GROUP, runId, attempt);
    // API root identity is rechecked independently by workerGate after decoding.
    validateArtifact(
      metadata,
      {
        runId,
        sourceSha: metadata.workflow_run?.head_sha,
        headBranch: metadata.workflow_run?.head_branch,
      },
      { id, name, digest: env.CANDIDATE_GRANT_DIGEST },
      65536,
    );
    const zip = join(directory, "grant.zip");
    await saveDownload(
      await githubResponse(`actions/artifacts/${id}/zip`, env.GH_TOKEN, request),
      zip,
      65536,
      metadata.size_in_bytes,
      env.CANDIDATE_GRANT_DIGEST,
    );
    const output = join(directory, "unpacked");
    execFileSync(
      "python3",
      [
        fileURLToPath(new URL("./extract-candidate-artifact.py", import.meta.url)),
        zip,
        output,
        "32768",
        '["grant.json"]',
      ],
      { timeout: 30000 },
    );
    const grant = JSON.parse(await readFile(join(output, "grant.json"), "utf8"));
    assert.equal(metadata.workflow_run.head_sha, grant.context.rootHeadSha);
    assert.equal(metadata.workflow_run.head_branch, grant.context.rootBranch);
    return grant;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  assert.ok(!env.CANDIDATE_GRANT_ID);
  const context = await readTrustedWorkerContext(env);
  const group = env.CANDIDATE_GRANT_GROUP;
  grantName(group, context.runId, context.attempt);
  const jobs = (await attemptJobs(context)).filter((job) => job.name === grantGroups[group].job);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "in_progress");
  assert.equal(jobs[0].run_attempt, context.attempt);
  const api = candidateGithub(env.GH_TOKEN);
  const release = await api.get(context.releaseId);
  const signatures = release.assets.filter((asset) => asset.name === "candidate-descriptor.sig");
  assert.equal(signatures.length, 1);
  const signature = (await api.read(signatures[0], 86)).toString("ascii");
  const descriptor = descriptorBytes(context.descriptor).toString("utf8");
  verifyDescriptor(Buffer.from(descriptor), signature);
  await requireAttempt(api, context.descriptor, context.releaseId, context.runId, context.attempt);
  await writeFile(
    join(env.RUNNER_TEMP, "grant.json"),
    JSON.stringify({
      kind: "paseo-worker-grant",
      schemaVersion: 1,
      group,
      context,
      descriptor,
      signature,
      workers: grantGroups[group].workers,
      authenticationJobId: jobs[0].id,
    }),
    { flag: "wx", mode: 0o600 },
  );
}
