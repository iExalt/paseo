import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchCandidate, hashFile, pairedJobs, validateCandidate } from "./candidate-artifacts.mjs";
import { validateCandidateClosure } from "./macos-candidate-runtime.mjs";
import { validateNixArtifactClosure } from "../../scripts/paseo-nix-update.mjs";
import { forkAndroidVersionCode } from "../../scripts/fork-version.mjs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { readTrustedWorkerContext } from "./candidate-worker.mjs";
import { attemptLedger } from "./candidate-attempts.mjs";
import { verifyCandidateProof } from "./step-proof.mjs";
import { producerGroups, validateCellReceipt } from "./candidate-matrix.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import { requireCurrentRun, requireAttempt, attemptWriter } from "./candidate-draft.mjs";
import { fileIdentity } from "./candidate-files.mjs";
import { readGithub } from "./release-pr-checks.mjs";

// Each slot is signed only after that job's verification and cleanup steps
// succeed, in whichever attempt last executed that job.
export async function pairedRuntime(context, platform, ledger) {
  assert.ok(["macos", "android"].includes(platform));
  async function completed(name, slot, workflow) {
    const producer = await ledger.producer(name);
    assert.equal(producer.job.run_id, context.runId);
    const proof = await verifyCandidateProof(
      { ...context, attempt: producer.attempt },
      slot,
      workflow,
    );
    assert.equal(proof.evidence, null);
    return producer;
  }
  if (platform === "macos") {
    await completed(pairedJobs.macos, "paired-macos-build", "macos-closure.yml");
    await completed(
      "paired / Build and verify macOS closure / Verify closure on a fresh runner",
      "paired-macos-import",
      "macos-closure.yml",
    );
  } else {
    await completed(pairedJobs.android, "paired-android-sign", "fork-android-apk.yml");
  }
  return completed(
    producerGroups[`${platform}-arm64`].job,
    `producer-${platform}-arm64`,
    "candidate-runtime.yml",
  );
}

export async function pairedReceipt(candidate, pin, context, platform, directory, producer, lanes) {
  validateCandidate(candidate, pin, lanes);
  assert.equal(pin.sourceSha, context.descriptor.sourceSha);
  assert.equal(pin.version, context.descriptor.version);
  assert.equal(Number(pin.runId), context.runId);
  assert.equal(Number(pin.attempt), lanes.crossCheck);
  const version = context.descriptor.version;
  let artifact, files;
  async function asset(file, name, sha256) {
    const bytes = (await stat(file)).size;
    assert.equal(await hashFile(file), sha256);
    const value = { name, bytes, sha256 };
    fileIdentity(value);
    return value;
  }
  if (platform === "macos") {
    const archive = join(directory, "macos", `${candidate.macOS.artifactName}.tar`);
    const closure = join(directory, "macos/manifest.json");
    assert.ok((await stat(closure)).size <= 1024 ** 2);
    artifact = {
      platform,
      arch: "arm64",
      kind: "nix-desktop",
      ...(await asset(
        archive,
        `paseo-${version}-macos-arm64-nix-desktop.tar`,
        candidate.macOS.archiveSha256,
      )),
      system: "aarch64-darwin",
      outputPath: candidate.macOS.outputPath,
      closureManifest: await asset(
        closure,
        `paseo-${version}-macos-arm64-nix-desktop.json`,
        candidate.macOS.manifestSha256,
      ),
    };
    assert.match(
      artifact.outputPath,
      new RegExp(
        `^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-paseo-desktop-${version.replaceAll(".", "\\.")}$`,
      ),
    );
    const bytes = await readFile(closure);
    validateCandidateClosure(JSON.parse(bytes), candidate);
    validateNixArtifactClosure(bytes, artifact, context.descriptor);
    files = [
      [artifact, archive],
      [artifact.closureManifest, closure],
    ];
  } else {
    assert.equal(platform, "android");
    const apk = join(
      directory,
      "android",
      `paseo-iexalt-fork-${candidate.android.versionCode}.apk`,
    );
    const metadataFile = join(directory, "android/build-metadata.json");
    assert.ok((await stat(metadataFile)).size <= 1024 ** 2);
    assert.equal(await hashFile(metadataFile), candidate.android.metadataSha256);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.kind, "paseo-verification-candidate");
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.platform, "android-arm64");
    assert.equal(metadata.sourceSha, pin.sourceSha);
    assert.equal(metadata.forkVersion, version);
    assert.equal(String(metadata.versionCode), candidate.android.versionCode);
    assert.equal(metadata.packageId, candidate.android.packageId);
    assert.equal(metadata.abi, "arm64-v8a");
    assert.equal(String(metadata.runId), String(context.runId));
    assert.equal(String(metadata.runAttempt), String(lanes.androidBuild));
    assert.equal(String(metadata.signingRunId), String(context.runId));
    assert.equal(String(metadata.signingRunAttempt), String(lanes.android));
    assert.equal(metadata.signingCertificateSha256, candidate.android.signingCertificateSha256);
    assert.equal(metadata.apkSha256, candidate.android.apkSha256);
    assert.ok(!Object.hasOwn(metadata, "releaseSequence"));
    artifact = {
      platform,
      arch: "arm64",
      kind: "apk",
      ...(await asset(apk, `paseo-${version}-android-arm64.apk`, candidate.android.apkSha256)),
      abi: "arm64-v8a",
      packageId: candidate.android.packageId,
      versionCode: forkAndroidVersionCode(version),
      signingCertificateSha256: candidate.android.signingCertificateSha256,
    };
    files = [[artifact, apk]];
  }
  const receipt = validateCellReceipt(
    {
      schemaVersion: 1,
      kind: "paseo-candidate-cell",
      descriptorSha256: descriptorDigest(context.descriptor),
      sourceSha: pin.sourceSha,
      treeSha: context.descriptor.treeSha,
      version,
      runId: context.runId,
      attempt: producer.attempt,
      group: `${platform}-arm64`,
      producerJobId: producer.job.id,
      cell: `${platform}/arm64/${artifact.kind}`,
      artifact,
      runtime: {
        passed: true,
        cleanup: true,
        signature: platform === "macos" ? "nix-pinned" : "android-pinned",
      },
    },
    context.descriptor,
    context.runId,
    producer.attempt,
  );
  return { receipt, files };
}

export async function transferPaired(
  env = process.env,
  {
    authenticate = readTrustedWorkerContext,
    request = readGithub,
    download = fetchCandidate,
    draftApi = candidateGithub,
  } = {},
) {
  const context = await authenticate(env);
  const { descriptor, releaseId, runId, attempt } = context;
  const platform = env.CANDIDATE_PLATFORM;
  assert.ok(["macos", "android"].includes(platform));
  const ledger = attemptLedger(context, request);
  const producer = await pairedRuntime(context, platform, ledger);
  const lanes = { crossCheck: (await ledger.producer(pairedJobs.crossCheck)).attempt };
  for (const [lane, name] of [
    ["android", pairedJobs.android],
    ["androidBuild", pairedJobs.androidBuild],
    ["macos", pairedJobs.macos],
  ])
    lanes[lane] = (await ledger.producer(name)).attempt;
  const pin = JSON.parse(env.CANDIDATE_PIN);
  const directory = join(
    env.RUNNER_TEMP,
    `candidate-paired-transfer-${platform}-${runId}-${attempt}`,
  );
  const candidate = await download(pin, directory, env.GH_TOKEN, platform, undefined, context);
  const { receipt, files } = await pairedReceipt(
    candidate,
    pin,
    context,
    platform,
    directory,
    producer,
    lanes,
  );
  const api = draftApi(env.GH_TOKEN);
  const writer = await attemptWriter(api, descriptor, releaseId, runId, attempt);
  for (const [asset, file] of files) {
    await requireCurrentRun(env, request, context.descriptor);
    await writer.file(asset.name, file, asset);
  }
  await requireCurrentRun(env, request, context.descriptor);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  await writer.bytes(
    `receipts-${platform}-arm64.json`,
    Buffer.from(JSON.stringify([receipt]) + "\n"),
  );
  await requireCurrentRun(env, request, context.descriptor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await transferPaired();
