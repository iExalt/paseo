import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchCandidate, hashFile, validateCandidate } from "./candidate-artifacts.mjs";
import { validateCandidateClosure } from "./macos-candidate-runtime.mjs";
import { validateNixArtifactClosure } from "../../scripts/paseo-nix-update.mjs";
import { forkAndroidVersionCode } from "../../scripts/fork-version.mjs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { readWorkerContext, attemptJobs } from "./candidate-worker.mjs";
import { verifyCompletedSteps } from "./candidate-product-transfer.mjs";
import { producerGroups, validateCellReceipt } from "./candidate-matrix.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import {
  requireCurrentRun,
  requireAttempt,
  uploadAttemptFile,
  uploadAttemptBytes,
} from "./candidate-draft.mjs";
import { fileIdentity } from "./candidate-files.mjs";
import { readGithub } from "./release-pr-checks.mjs";

export function pairedRuntime(context, platform, jobs) {
  assert.ok(["macos", "android"].includes(platform));
  function completed(name, steps) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate ${name}`);
    const job = matches[0];
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    assert.equal(job.run_id, context.runId);
    assert.equal(job.run_attempt, context.attempt);
    verifyCompletedSteps(job, steps);
    return job.id;
  }
  const auth = "Authenticate candidate and admitted attempt";
  if (platform === "macos") {
    completed("paired / Build and verify macOS closure / Build and sign macOS closure", [
      auth,
      "Read authenticated candidate source",
      "Sign and export the closure",
      "Remove temporary Nix signing key file",
      "Upload public closure and metadata artifact",
    ]);
    completed("paired / Build and verify macOS closure / Verify closure on a fresh runner", [
      auth,
      "Read authenticated candidate source",
      "Import and verify signed closure",
    ]);
  } else {
    completed("paired / Build and sign Android APK / Sign and publish fork APK artifact", [
      auth,
      "Sign and verify with the approved fork certificate",
      "Remove signing material",
    ]);
  }
  return completed(producerGroups[`${platform}-arm64`].job, [
    auth,
    ...(platform === "macos"
      ? ["Verify canonical signed packages and preserved native state"]
      : [
          "Verify signed ARM64 APKs and retained native state",
          "Remove owned Android container after interruption",
        ]),
  ]);
}

export async function pairedReceipt(candidate, pin, context, platform, directory, producerJobId) {
  validateCandidate(candidate, pin, true);
  assert.equal(pin.sourceSha, context.descriptor.sourceSha);
  assert.equal(pin.version, context.descriptor.version);
  assert.equal(Number(pin.runId), context.runId);
  assert.equal(Number(pin.attempt), context.attempt);
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
    assert.equal(String(metadata.runAttempt), String(context.attempt));
    assert.equal(String(metadata.signingRunId), String(context.runId));
    assert.equal(String(metadata.signingRunAttempt), String(context.attempt));
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
      attempt: context.attempt,
      group: `${platform}-arm64`,
      producerJobId,
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
    context.attempt,
  );
  return { receipt, files };
}

export async function transferPaired(
  env = process.env,
  {
    authenticate = readWorkerContext,
    request = readGithub,
    download = fetchCandidate,
    draftApi = candidateGithub,
  } = {},
) {
  const context = await authenticate(env);
  const { descriptor, releaseId, runId, attempt } = context;
  const platform = env.CANDIDATE_PLATFORM;
  const producerJobId = pairedRuntime(context, platform, await attemptJobs(context, request));
  const pin = JSON.parse(env.CANDIDATE_PIN);
  const directory = join(
    env.RUNNER_TEMP,
    `candidate-paired-transfer-${platform}-${runId}-${attempt}`,
  );
  const candidate = await download(pin, directory, env.GH_TOKEN, platform);
  const { receipt, files } = await pairedReceipt(
    candidate,
    pin,
    context,
    platform,
    directory,
    producerJobId,
  );
  const api = draftApi(env.GH_TOKEN);
  for (const [asset, file] of files) {
    await requireCurrentRun(env, request);
    await uploadAttemptFile(api, descriptor, releaseId, runId, attempt, asset.name, file, asset);
  }
  await requireCurrentRun(env, request);
  await requireAttempt(api, descriptor, releaseId, runId, attempt);
  await uploadAttemptBytes(
    api,
    descriptor,
    releaseId,
    runId,
    attempt,
    `receipts-${platform}-arm64.json`,
    Buffer.from(JSON.stringify([receipt]) + "\n"),
  );
  await requireCurrentRun(env, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await transferPaired();
