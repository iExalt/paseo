#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
  serializePaseoReleaseManifest,
  validatePaseoReleaseManifest,
} from "../packages/protocol/src/release-manifest.ts";

const REPOSITORY = "iExalt/paseo";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(ROOT, ".dev/fork-auto-update/promotions");
const PROMOTION_TAG_PREFIX = "paseo-fork-v";
const PROMOTION_MANIFEST_ASSET = "paseo-release-manifest.json";
const PROMOTION_SIGNATURE_ASSET = "paseo-release-manifest.sig";
const PUBLIC_KEY_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function fail(message) {
  throw new Error(message);
}

function normalizeSha256Digest(value) {
  if (typeof value !== "string") return null;
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function matchesSha256Digest(actualValue, expectedValue) {
  const actualDigest = normalizeSha256Digest(actualValue);
  const expectedDigest = normalizeSha256Digest(expectedValue);
  return actualDigest !== null && expectedDigest !== null && actualDigest === expectedDigest;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "prepare" && command !== "publish") {
    fail("Usage: promote-fork-release.mjs prepare|publish --name value ...");
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key?.startsWith("--") || index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
      fail(`Expected a value after ${key ?? "argument"}.`);
    }
    if (options.has(key)) {
      fail(`Repeated option ${key}.`);
    }
    options.set(key, rest[index + 1]);
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options.get(`--${name}`);
  if (!value) {
    fail(`Missing --${name}.`);
  }
  return value;
}

function canonicalInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(`${name} must be a canonical positive integer.`);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    fail(`${name} exceeds the safe integer range.`);
  }
  return numeric;
}

function gh(args, { capture = false } = {}) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, GH_REPO: REPOSITORY },
  });
  if (result.error) {
    fail(`Could not run gh ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = capture ? String(result.stderr ?? "").trim() : "";
    fail(`gh ${args[0]} failed${details ? `: ${details}` : "."}`);
  }
  return capture ? String(result.stdout ?? "") : "";
}

function ghJson(args) {
  try {
    return JSON.parse(gh(args, { capture: true }));
  } catch (error) {
    fail(
      `Could not read GitHub response: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

function getGitHubToken() {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    fail("GitHub CLI authentication is required; run `gh auth status` and retry.");
  }
  return result.stdout.trim();
}

async function apiRequest(token, endpoint, init = {}) {
  const response = await fetch(`${API_ORIGIN}${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      ...init.headers,
    },
    redirect: "follow",
  });
  return response;
}

async function apiJson(token, endpoint, init = {}) {
  const response = await apiRequest(token, endpoint, init);
  if (!response.ok) {
    fail(`GitHub API request failed (${response.status}) for ${endpoint}.`);
  }
  return response.json();
}

async function validateRunApi(token, runId, expected) {
  const run = await apiJson(
    token,
    `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${expected.attempt}`,
  );
  if (
    run.id !== Number(runId) ||
    run.run_attempt !== expected.attempt ||
    run.event !== "push" ||
    run.head_branch !== "dev" ||
    run.head_sha !== expected.sourceSha ||
    run.actor?.login !== "iExalt" ||
    run.head_repository?.full_name !== REPOSITORY ||
    typeof run.path !== "string" ||
    !run.path.split("@")[0].endsWith(".github/workflows/fork-builds.yml")
  ) {
    fail("Selected GitHub run API identity is not the trusted fork dev build.");
  }
}

function assertPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value;
}

function assertSafeRelativePath(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    fail(`${label} is unsafe.`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${label} escapes its staging directory.`);
  }
  return absolute;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function validateRun(run, expected) {
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "push" ||
    run.headBranch !== "dev" ||
    run.headSha !== expected.sourceSha ||
    run.attempt !== expected.attempt ||
    run.workflowName !== "Fork release candidate builds"
  ) {
    fail(
      "Selected run is not a successful trusted paired build for the supplied source and attempt.",
    );
  }
}

function expectedCandidateArtifactName(sourceSha, attempt, sequence) {
  return `paseo-paired-candidate-${sequence}-${sourceSha}-attempt-${attempt}`;
}

export function parseLaneArtifactAttempt(value, selectedAttempt, lane) {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > selectedAttempt
  ) {
    fail(`Candidate ${lane} artifact attempt is invalid for the selected workflow attempt.`);
  }
  return Number(value);
}

function verifyArtifactMetadata(artifact, id, runId, sourceSha, expectedName) {
  if (artifact.id !== Number(id) || artifact.workflow_run?.id !== Number(runId)) {
    fail(`Artifact ${id} is not attached to the selected workflow run.`);
  }
  if (
    artifact.workflow_run?.head_sha !== sourceSha ||
    artifact.workflow_run?.head_branch !== "dev" ||
    artifact.expired ||
    artifact.name !== expectedName
  ) {
    fail(`Artifact ${id} has expired or does not match the selected source and attempt.`);
  }
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
    fail(`Artifact ${id} has an invalid size.`);
  }
  if (!normalizeSha256Digest(artifact.digest)) {
    fail(`Artifact ${id} has no verifiable SHA-256 digest.`);
  }
}

async function downloadArtifact(token, artifact, destination) {
  const response = await apiRequest(
    token,
    `/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
  );
  if (!response.ok || !response.body) {
    fail(`Artifact ${artifact.id} download failed (${response.status}).`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const actualDigest = hash.digest("hex");
  if (bytes !== artifact.size_in_bytes || actualDigest !== normalizeSha256Digest(artifact.digest)) {
    fail(`Downloaded artifact ${artifact.id} differs from GitHub's size or digest.`);
  }
  return { bytes, sha256: actualDigest };
}

export async function extractExpectedZip(zipPath, destination, expectedFiles, optionalFiles = []) {
  const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const allowedFiles = new Set([...expectedFiles, ...optionalFiles]);
  if (
    new Set(names).size !== names.length ||
    expectedFiles.some((name) => !names.includes(name)) ||
    names.some(
      (name) =>
        !allowedFiles.has(name) ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").includes("..") ||
        name.includes("/"),
    )
  ) {
    fail("Artifact ZIP contains unexpected or unsafe entries.");
  }
  // Optional APK v4 signatures are accepted as producer output but never staged or released.
  execFileSync("unzip", ["-qq", "-n", zipPath, ...expectedFiles, "-d", destination], {
    stdio: "ignore",
  });
  for (const name of expectedFiles) {
    const path = join(destination, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail(`Artifact entry ${name} is not a regular file.`);
    }
  }
}

async function verifySha256Sums(directory, expectedFiles) {
  const lines = execFileSync("cat", [join(directory, "SHA256SUMS")], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/);
  const declared = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !expectedFiles.includes(match[2]) || declared.has(match[2])) {
      fail("Artifact SHA256SUMS is malformed or names an unexpected file.");
    }
    declared.set(match[2], match[1]);
  }
  if (declared.size !== expectedFiles.length) {
    fail("Artifact SHA256SUMS does not cover every expected file.");
  }
  for (const name of expectedFiles) {
    const path = join(directory, name);
    const actual = await hashFile(path);
    if (actual.sha256 !== declared.get(name)) {
      fail(`Artifact file ${name} does not match SHA256SUMS.`);
    }
  }
}

export function validateCandidate(candidate, expected, ids, digests) {
  assertPlainObject(candidate, "Paired candidate manifest");
  if (
    candidate.schemaVersion !== 1 ||
    candidate.status !== "candidate" ||
    candidate.sourceSha !== expected.sourceSha ||
    candidate.runId !== expected.runId ||
    candidate.runAttempt !== String(expected.attempt) ||
    candidate.releaseSequence !== expected.sequence
  ) {
    fail("Paired candidate manifest does not match the selected run identity.");
  }
  const laneAttempts = {};
  for (const lane of ["macOS", "android"]) {
    const value = assertPlainObject(candidate[lane], `Candidate ${lane} lane`);
    const sourceLane = lane === "macOS" ? "macos" : "android";
    laneAttempts[sourceLane] = parseLaneArtifactAttempt(
      value.artifactRunAttempt,
      expected.attempt,
      lane,
    );
    if (
      String(value.artifactId) !== ids[sourceLane] ||
      !matchesSha256Digest(value.artifactDigest, digests[sourceLane]) ||
      value.sourceSha !== undefined
    ) {
      fail(`Paired candidate ${lane} artifact identity does not match the selected artifact.`);
    }
  }
  candidate.laneAttempts = laneAttempts;
  if (
    candidate.macOS.artifactName !==
      `paseo-nix-closure-${expected.sourceSha}-${expected.sequence}-attempt-${laneAttempts.macos}` ||
    candidate.android.artifactName !==
      `paseo-iexalt-${expected.sequence}-${expected.sourceSha}-attempt-${laneAttempts.android}` ||
    candidate.android.versionCode !== String(expected.sequence) ||
    candidate.android.packageId !== "sh.paseo.iexalt" ||
    candidate.android.signingCertificateSha256 !==
      "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459" ||
    candidate.macOS.system !== "aarch64-darwin" ||
    candidate.macOS.provenance !== "local-ci-build" ||
    candidate.macOS.nodeSeedProvenance !== "local-built-dependency"
  ) {
    fail("Paired candidate platform identity or verification state is unsupported.");
  }
}

export async function validateLaneFiles(paths, candidate, expected) {
  const androidMetadata = JSON.parse(
    execFileSync("cat", [paths.androidMetadata], { encoding: "utf8" }),
  );
  const androidHash = (await hashFile(paths.androidApk)).sha256;
  const androidMetadataHash = (await hashFile(paths.androidMetadata)).sha256;
  assertAndroidLaneMatches(androidMetadata, candidate, expected, androidHash, androidMetadataHash);
  const macManifest = JSON.parse((await readFile(paths.macManifest)).toString("utf8"));
  const macManifestResult = await hashFile(paths.macManifest);
  const macArchiveResult = await hashFile(paths.macArchive);
  assertMacLaneMatches(
    macManifest,
    candidate,
    expected,
    macManifestResult.sha256,
    macArchiveResult.sha256,
  );
  return {
    packageVersion: macManifest.packageVersion,
    androidMetadata,
    macManifest,
    androidApkBytes: (await hashFile(paths.androidApk)).bytes,
    androidMetadataBytes: (await hashFile(paths.androidMetadata)).bytes,
    macArchiveBytes: macArchiveResult.bytes,
    macManifestBytes: macManifestResult.bytes,
  };
}

function assertAndroidLaneMatches(
  androidMetadata,
  candidate,
  expected,
  androidHash,
  androidMetadataHash,
) {
  if (
    androidMetadata.sourceSha !== expected.sourceSha ||
    androidMetadata.runId !== expected.runId ||
    androidMetadata.signingRunId !== expected.runId ||
    Number(androidMetadata.signingRunAttempt) !== candidate.laneAttempts.android ||
    !/^[1-9][0-9]*$/.test(androidMetadata.runAttempt) ||
    Number(androidMetadata.runAttempt) > candidate.laneAttempts.android ||
    Number(androidMetadata.releaseSequence) !== expected.sequence ||
    Number(androidMetadata.versionCode) !== expected.sequence ||
    androidMetadata.packageId !== "sh.paseo.iexalt" ||
    androidMetadata.abi !== "arm64-v8a" ||
    androidMetadata.signingCertificateSha256 !== candidate.android.signingCertificateSha256 ||
    androidMetadata.apkSha256 !== androidHash ||
    androidHash !== candidate.android.apkSha256 ||
    androidMetadataHash !== candidate.android.metadataSha256
  ) {
    fail("Android APK or signed build metadata differs from the paired candidate.");
  }
}

function assertMacLaneMatches(macManifest, candidate, expected, macManifestHash, macArchiveHash) {
  if (
    macManifestHash !== candidate.macOS.manifestSha256 ||
    macArchiveHash !== candidate.macOS.archiveSha256 ||
    macManifest.sourceSha !== expected.sourceSha ||
    Number(macManifest.releaseSequence) !== expected.sequence ||
    macManifest.lockHash !== candidate.macOS.lockHash ||
    macManifest.system !== "aarch64-darwin" ||
    macManifest.outputPath !== candidate.macOS.outputPath ||
    macManifest.provenance !== "local-ci-build" ||
    macManifest.nodeSeedProvenance !== "local-built-dependency" ||
    !Array.isArray(macManifest.closure) ||
    !macManifest.closure.some((entry) => entry.path === candidate.macOS.outputPath)
  ) {
    fail("macOS closure archive or manifest differs from the paired candidate.");
  }
}

function makeReleaseManifest(candidate, expected, files, toolSha, rollbackOf) {
  const releaseTag = `${PROMOTION_TAG_PREFIX}${files.packageVersion}-r${expected.sequence}-${expected.sourceSha}`;
  const manifest = {
    schemaVersion: 1,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    channel: "fork",
    releaseTag,
    sourceSha: expected.sourceSha,
    runId: expected.runId,
    runAttempt: expected.attempt,
    releaseSequence: expected.sequence,
    packageVersion: files.packageVersion,
    promotionToolSha: toolSha,
    createdAt: new Date().toISOString(),
    macOS: {
      system: "aarch64-darwin",
      outputPath: candidate.macOS.outputPath,
      closureArchive: {
        name: candidate.macOS.archiveName,
        bytes: files.macArchiveBytes,
        sha256: candidate.macOS.archiveSha256,
      },
      closureManifest: {
        name: "paseo-macos-closure-manifest.json",
        bytes: files.macManifestBytes,
        sha256: candidate.macOS.manifestSha256,
      },
    },
    android: {
      abi: "arm64-v8a",
      packageId: "sh.paseo.iexalt",
      versionCode: expected.sequence,
      signingCertificateSha256: candidate.android.signingCertificateSha256,
      apk: {
        name: "paseo-android-arm64.apk",
        bytes: files.androidApkBytes,
        sha256: candidate.android.apkSha256,
      },
      buildMetadata: {
        name: "paseo-android-build-metadata.json",
        bytes: files.androidMetadataBytes,
        sha256: candidate.android.metadataSha256,
      },
    },
    rollbackOf,
  };
  validatePaseoReleaseManifest(manifest);
  return manifest;
}

export function validateReleaseMonotonicity(candidate, priorManifests, rollbackTag = null) {
  const highestSequence = priorManifests.reduce(
    (highest, manifest) => Math.max(highest, manifest.releaseSequence),
    0,
  );
  const highestAndroidCode = priorManifests.reduce(
    (highest, manifest) => Math.max(highest, manifest.android.versionCode),
    0,
  );
  if (
    candidate.releaseSequence <= highestSequence ||
    candidate.android.versionCode <= highestAndroidCode
  ) {
    fail(
      "Release sequence and Android version code must both exceed every prior promoted release.",
    );
  }
  if (rollbackTag === null) {
    if (candidate.rollbackOf !== null) {
      fail("Manifest rollback metadata requires an explicit known rollback target.");
    }
    return;
  }
  const target = priorManifests.find((manifest) => manifest.releaseTag === rollbackTag);
  if (!target) {
    fail("Rollback target is not a verified published release.");
  }
  if (
    candidate.rollbackOf?.releaseTag !== target.releaseTag ||
    candidate.rollbackOf.sourceSha !== target.sourceSha ||
    candidate.rollbackOf.releaseSequence !== target.releaseSequence ||
    candidate.rollbackOf.androidVersionCode !== target.android.versionCode
  ) {
    fail("Rollback metadata differs from the selected signed prior release.");
  }
}

export function assertPromotionTagAvailable(tagExists, releaseExists) {
  if (tagExists || releaseExists) {
    fail("Promotion tag or release already exists; refusing to overwrite it.");
  }
}

export function assertDigestMatches(expected, actual, label) {
  if (expected !== actual) {
    fail(`${label} digest does not match its pinned SHA-256.`);
  }
}

export function isPublishedPromotionRelease(release) {
  return (
    !release.draft &&
    !release.prerelease &&
    typeof release.tag_name === "string" &&
    /^paseo-fork-v\d+\.\d+\.\d+(?:-beta\.\d+)?-r[1-9][0-9]*-[a-f0-9]{40}$/.test(release.tag_name)
  );
}

function parseSignatureFile(signatureBytes) {
  const value = signatureBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) {
    fail("Detached manifest signature is malformed.");
  }
  return Buffer.from(value, "base64url");
}

export function verifyReleaseManifestSignatureBytes(
  manifestBytes,
  signatureBytes,
  publicKeyBase64url = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    validatePaseoReleaseManifest(manifest);
  } catch {
    fail("Release manifest is invalid.");
  }
  const signature = parseSignatureFile(signatureBytes);
  const rawPublicKey = Buffer.from(publicKeyBase64url, "base64url");
  const publicKey = createPublicKey({
    key: Buffer.concat([PUBLIC_KEY_SPKI_PREFIX, rawPublicKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, manifestBytes, publicKey, signature)) {
    fail("Release manifest signature does not match the pinned key.");
  }
  return manifest;
}

export function verifyReleaseManifestSignature(manifestBytes, signatureBytes) {
  return verifyReleaseManifestSignatureBytes(manifestBytes, signatureBytes);
}

function expectedArtifacts(args) {
  return {
    candidate: required(args, "candidate-artifact-id"),
    macos: required(args, "macos-artifact-id"),
    android: required(args, "android-artifact-id"),
  };
}

async function fetchSelectedArtifacts(token, args, identity, destination) {
  await mkdir(destination, { recursive: false });
  const ids = expectedArtifacts(args);
  const artifacts = {};
  for (const lane of ["candidate", "macos", "android"]) {
    const id = ids[lane];
    canonicalInteger(id, `${lane} artifact ID`);
    artifacts[lane] = await apiJson(token, `/repos/${REPOSITORY}/actions/artifacts/${id}`);
    if (lane === "candidate") {
      verifyArtifactMetadata(
        artifacts[lane],
        id,
        identity.runId,
        identity.sourceSha,
        expectedCandidateArtifactName(identity.sourceSha, identity.attempt, identity.sequence),
      );
    } else if (
      artifacts[lane].id !== Number(id) ||
      artifacts[lane].workflow_run?.id !== Number(identity.runId) ||
      artifacts[lane].workflow_run?.head_sha !== identity.sourceSha ||
      artifacts[lane].workflow_run?.head_branch !== "dev" ||
      artifacts[lane].expired ||
      !Number.isSafeInteger(artifacts[lane].size_in_bytes) ||
      artifacts[lane].size_in_bytes <= 0 ||
      !normalizeSha256Digest(artifacts[lane].digest)
    ) {
      fail(`Platform artifact ${id} is not a valid artifact from the selected source.`);
    }
  }
  const digestMap = Object.fromEntries(
    Object.entries(artifacts).map(([lane, artifact]) => [
      lane,
      normalizeSha256Digest(artifact.digest),
    ]),
  );
  const zipPaths = {};
  for (const lane of ["candidate", "macos", "android"]) {
    zipPaths[lane] = join(destination, `${lane}.zip`);
    await downloadArtifact(token, artifacts[lane], zipPaths[lane]);
  }
  const extracted = {};
  for (const lane of ["candidate", "macos", "android"]) {
    extracted[lane] = join(destination, lane);
    await mkdir(extracted[lane], { recursive: false });
  }
  await extractExpectedZip(zipPaths.candidate, extracted.candidate, [
    "paired-candidate.json",
    "SHA256SUMS",
  ]);
  const candidate = JSON.parse(
    execFileSync("cat", [join(extracted.candidate, "paired-candidate.json")], { encoding: "utf8" }),
  );
  validateCandidate(candidate, identity, ids, digestMap);
  verifyArtifactMetadata(
    artifacts.macos,
    ids.macos,
    identity.runId,
    identity.sourceSha,
    candidate.macOS.artifactName,
  );
  verifyArtifactMetadata(
    artifacts.android,
    ids.android,
    identity.runId,
    identity.sourceSha,
    candidate.android.artifactName,
  );
  const androidApkName = `paseo-iexalt-fork-${identity.sequence}.apk`;
  candidate.macOS.archiveName = `${candidate.macOS.artifactName}.tar`;
  await extractExpectedZip(
    zipPaths.android,
    extracted.android,
    [androidApkName, "build-metadata.json", "SHA256SUMS"],
    [`${androidApkName}.idsig`],
  );
  await extractExpectedZip(zipPaths.macos, extracted.macos, [
    candidate.macOS.archiveName,
    "manifest.json",
    "SHA256SUMS",
  ]);
  await verifySha256Sums(extracted.candidate, ["paired-candidate.json"]);
  await verifySha256Sums(extracted.android, [androidApkName, "build-metadata.json"]);
  await verifySha256Sums(extracted.macos, [candidate.macOS.archiveName, "manifest.json"]);
  const paths = {
    androidApk: join(extracted.android, androidApkName),
    androidMetadata: join(extracted.android, "build-metadata.json"),
    macArchive: join(extracted.macos, candidate.macOS.archiveName),
    macManifest: join(extracted.macos, "manifest.json"),
  };
  const files = await validateLaneFiles(paths, candidate, identity);
  return { ids, artifacts, digestMap, paths, candidate, files, zipPaths, extracted };
}

function currentToolSha() {
  const output = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(output)) {
    fail("Could not determine the reviewed promotion-tool commit.");
  }
  return output;
}

function validatePromotionFilesClean() {
  const paths = [
    "scripts/promote-fork-release.mjs",
    "scripts/promote-fork-release.test.mjs",
    "packages/protocol/src/release-manifest.ts",
    "packages/protocol/src/release-manifest.test.ts",
  ];
  const diff = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (diff.status !== 0 || diff.stdout.trim()) {
    fail("Promotion implementation has uncommitted changes; use a reviewed clean checkout.");
  }
}

async function prepare(options) {
  const runId = required(options, "run-id");
  canonicalInteger(runId, "run ID");
  const attempt = canonicalInteger(required(options, "attempt"), "run attempt");
  const sourceSha = required(options, "source-sha");
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
    fail("Source SHA must be a full lowercase Git commit ID.");
  }
  const ids = expectedArtifacts(options);
  for (const [name, id] of Object.entries(ids)) {
    canonicalInteger(id, `${name} artifact ID`);
  }
  const run = ghJson([
    "run",
    "view",
    runId,
    "--attempt",
    String(attempt),
    "--repo",
    REPOSITORY,
    "--json",
    "status,conclusion,event,headBranch,headSha,attempt,workflowName,jobs",
  ]);
  validateRun(run, { sourceSha, attempt });
  const token = getGitHubToken();
  await validateRunApi(token, runId, { sourceSha, attempt });
  const baseDir = join(WORK_DIR, `run-${runId}-attempt-${attempt}`);
  try {
    await lstat(baseDir);
    fail(`Refusing to overwrite existing promotion staging directory: ${baseDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const identity = { runId, attempt, sourceSha, sequence: null };
  // Read the sequence only from the candidate artifact after its API digest is verified.
  const initialId = ids.candidate;
  const candidateMetadata = await apiJson(
    token,
    `/repos/${REPOSITORY}/actions/artifacts/${initialId}`,
  );
  if (
    candidateMetadata.workflow_run?.id !== Number(runId) ||
    candidateMetadata.workflow_run?.head_sha !== sourceSha ||
    candidateMetadata.expired
  ) {
    fail("Candidate manifest artifact does not belong to the selected run.");
  }
  const candidateZip = join(baseDir, "candidate.zip");
  await downloadArtifact(token, candidateMetadata, candidateZip);
  const candidateDir = join(baseDir, "preflight-candidate");
  await mkdir(candidateDir, { recursive: false });
  await extractExpectedZip(candidateZip, candidateDir, ["paired-candidate.json", "SHA256SUMS"]);
  await verifySha256Sums(candidateDir, ["paired-candidate.json"]);
  const candidate = JSON.parse(
    execFileSync("cat", [join(candidateDir, "paired-candidate.json")], { encoding: "utf8" }),
  );
  identity.sequence = candidate.releaseSequence;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.status !== "candidate" ||
    candidate.runId !== runId ||
    candidate.runAttempt !== String(attempt) ||
    candidate.sourceSha !== sourceSha ||
    !Number.isSafeInteger(identity.sequence) ||
    identity.sequence <= 0
  ) {
    fail("Candidate manifest does not match the selected run and source.");
  }
  const names = {
    candidate: expectedCandidateArtifactName(sourceSha, attempt, identity.sequence),
  };
  verifyArtifactMetadata(candidateMetadata, ids.candidate, runId, sourceSha, names.candidate);
  const all = await fetchSelectedArtifacts(token, options, identity, join(baseDir, "artifacts"));
  names.macos = all.candidate.macOS.artifactName;
  names.android = all.candidate.android.artifactName;
  const receipt = {
    schemaVersion: 1,
    repository: REPOSITORY,
    run: { id: runId, attempt, sourceSha, releaseSequence: identity.sequence },
    artifactIds: ids,
    artifactDigests: all.digestMap,
    artifactNames: names,
    rollbackOf: options.get("--rollback-of") ?? null,
    stagingDirectory: relative(ROOT, baseDir),
    candidateManifestSha256: (
      await hashFile(join(all.extracted.candidate, "paired-candidate.json"))
    ).sha256,
    promotionToolSha: currentToolSha(),
    preparedAt: new Date().toISOString(),
  };
  await writeFile(
    join(baseDir, "promotion-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ status: "prepared", receipt: relative(ROOT, join(baseDir, "promotion-receipt.json")), sourceSha, releaseSequence: identity.sequence, runId, attempt })}\n`,
  );
}

async function readReceipt(receiptPath) {
  const absolute = resolve(ROOT, receiptPath);
  const rel = relative(WORK_DIR, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("Promotion receipt must be under .dev/fork-auto-update/promotions.");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("Promotion receipt must be a regular file.");
  }
  return { absolute, receipt: JSON.parse(await readFile(absolute, "utf8")) };
}

async function listPriorReleases(token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await apiJson(token, `/repos/${REPOSITORY}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      fail("GitHub release inventory response is invalid.");
    }
    releases.push(...batch.filter(isPublishedPromotionRelease));
    if (batch.length < 100) {
      break;
    }
  }
  return releases;
}

async function downloadReleaseAsset(token, release, assetName, destination) {
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset || asset.state !== "uploaded") {
    fail(`Prior release ${release.tag_name} is missing ${assetName}.`);
  }
  const response = await apiRequest(token, `/repos/${REPOSITORY}/releases/assets/${asset.id}`, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    fail(`Could not download signed metadata from ${release.tag_name}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const actual = await hashFile(destination);
  if (asset.size !== actual.bytes || (asset.digest && asset.digest !== `sha256:${actual.sha256}`)) {
    fail(`Prior release ${release.tag_name} metadata asset digest is invalid.`);
  }
}

async function verifiedPriorManifests(token, releases, destination) {
  const manifests = [];
  await mkdir(destination, { recursive: false });
  for (const release of releases) {
    const dir = join(destination, `prior-${release.id}`);
    await mkdir(dir, { recursive: false });
    const manifestPath = join(dir, PROMOTION_MANIFEST_ASSET);
    const signaturePath = join(dir, PROMOTION_SIGNATURE_ASSET);
    await downloadReleaseAsset(token, release, PROMOTION_MANIFEST_ASSET, manifestPath);
    await downloadReleaseAsset(token, release, PROMOTION_SIGNATURE_ASSET, signaturePath);
    const manifest = verifyReleaseManifestSignature(
      await readFile(manifestPath),
      await readFile(signaturePath),
    );
    if (manifest.releaseTag !== release.tag_name) {
      fail(`Signed manifest release tag does not match ${release.tag_name}.`);
    }
    manifests.push(manifest);
  }
  return manifests;
}

function expectedAssetPins(manifest, paths) {
  return [
    {
      name: manifest.macOS.closureArchive.name,
      path: paths.macArchive,
      sha256: manifest.macOS.closureArchive.sha256,
    },
    {
      name: manifest.macOS.closureManifest.name,
      path: paths.macManifest,
      sha256: manifest.macOS.closureManifest.sha256,
    },
    {
      name: manifest.android.apk.name,
      path: paths.androidApk,
      sha256: manifest.android.apk.sha256,
    },
    {
      name: manifest.android.buildMetadata.name,
      path: paths.androidMetadata,
      sha256: manifest.android.buildMetadata.sha256,
    },
    {
      name: PROMOTION_MANIFEST_ASSET,
      path: paths.releaseManifest,
      sha256: paths.releaseManifestHash,
    },
    {
      name: PROMOTION_SIGNATURE_ASSET,
      path: paths.releaseSignature,
      sha256: paths.releaseSignatureHash,
    },
  ];
}

async function signingKeyMatchesPin(keyPath) {
  const info = await lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail("Manifest signing key must be a regular nonsymlink file with owner-only permissions.");
  }
  const key = createPrivateKey(await readFile(keyPath));
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32).toString("base64url");
  if (raw !== PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL) {
    fail("Promotion private key does not match the pinned Ed25519 public key.");
  }
  return key;
}

function validateReceipt(receipt) {
  assertPlainObject(receipt, "Promotion receipt");
  if (receipt.schemaVersion !== 1 || receipt.repository !== REPOSITORY) {
    fail("Promotion receipt schema or repository is unsupported.");
  }
  const run = assertPlainObject(receipt.run, "Promotion run");
  canonicalInteger(String(run.id), "run ID");
  canonicalInteger(String(run.attempt), "run attempt");
  canonicalInteger(String(run.releaseSequence), "release sequence");
  if (!/^[a-f0-9]{40}$/.test(run.sourceSha)) {
    fail("Promotion receipt source SHA is invalid.");
  }
  return {
    runId: String(run.id),
    attempt: Number(run.attempt),
    sourceSha: run.sourceSha,
    sequence: Number(run.releaseSequence),
  };
}

async function revalidatePreparedArtifacts(token, receipt, expected, baseDir) {
  const run = ghJson([
    "run",
    "view",
    expected.runId,
    "--attempt",
    String(expected.attempt),
    "--repo",
    REPOSITORY,
    "--json",
    "status,conclusion,event,headBranch,headSha,attempt,workflowName,jobs",
  ]);
  validateRun(run, expected);
  await validateRunApi(token, expected.runId, expected);
  if (
    receipt.artifactNames?.candidate !==
    expectedCandidateArtifactName(expected.sourceSha, expected.attempt, expected.sequence)
  ) {
    fail("Promotion receipt artifact names do not match its immutable identity.");
  }
  const all = await fetchSelectedArtifacts(
    token,
    new Map(
      Object.entries({
        "--candidate-artifact-id": String(receipt.artifactIds.candidate),
        "--macos-artifact-id": String(receipt.artifactIds.macos),
        "--android-artifact-id": String(receipt.artifactIds.android),
      }),
    ),
    expected,
    join(baseDir, "revalidation"),
  );
  if (
    JSON.stringify(all.digestMap) !== JSON.stringify(receipt.artifactDigests) ||
    all.candidate.sourceSha !== expected.sourceSha ||
    all.candidate.runId !== expected.runId ||
    all.candidate.runAttempt !== String(expected.attempt)
  ) {
    fail("Revalidated artifacts differ from the prepared receipt.");
  }
  if (
    receipt.artifactNames.macos !== all.candidate.macOS.artifactName ||
    receipt.artifactNames.android !== all.candidate.android.artifactName
  ) {
    fail("Promotion receipt lane artifact names differ from the paired candidate.");
  }
  return all;
}

async function createReleasePayload(token, receipt, expected, all, baseDir, options) {
  const toolSha = currentToolSha();
  validatePromotionFilesClean();
  const releases = await listPriorReleases(token);
  const priorManifests = await verifiedPriorManifests(
    token,
    releases,
    join(baseDir, "prior-releases"),
  );
  const rollbackTag = receipt.rollbackOf;
  let rollbackOf = null;
  if (rollbackTag) {
    const target = priorManifests.find((manifest) => manifest.releaseTag === rollbackTag);
    if (!target) {
      fail("Requested rollback target is not an authenticated prior release.");
    }
    rollbackOf = {
      releaseTag: target.releaseTag,
      sourceSha: target.sourceSha,
      releaseSequence: target.releaseSequence,
      androidVersionCode: target.android.versionCode,
    };
  }
  const manifest = makeReleaseManifest(all.candidate, expected, all.files, toolSha, rollbackOf);
  validateReleaseMonotonicity(manifest, priorManifests, rollbackTag);

  const manifestPath = join(baseDir, PROMOTION_MANIFEST_ASSET);
  const signaturePath = join(baseDir, PROMOTION_SIGNATURE_ASSET);
  const keyPath = required(options, "private-key-file");
  const keyInfo = await lstat(keyPath);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) {
    fail("Manifest signing key must be a regular nonsymlink file.");
  }
  const privateKey = await signingKeyMatchesPin(keyPath);
  const manifestBytes = Buffer.from(serializePaseoReleaseManifest(manifest));
  const signatureBytes = Buffer.from(
    `${sign(null, manifestBytes, privateKey).toString("base64url")}\n`,
  );
  await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
  await writeFile(signaturePath, signatureBytes, { flag: "wx", mode: 0o600 });
  const releaseAssets = expectedAssetPins(manifest, {
    ...all.paths,
    releaseManifest: manifestPath,
    releaseSignature: signaturePath,
    releaseManifestHash: createHash("sha256").update(manifestBytes).digest("hex"),
    releaseSignatureHash: createHash("sha256").update(signatureBytes).digest("hex"),
  });
  const releaseDir = join(baseDir, "release-assets");
  await mkdir(releaseDir, { recursive: false });
  for (const asset of releaseAssets) {
    const target = join(releaseDir, asset.name);
    await copyFileNoOverwrite(asset.path, target);
    const actual = await hashFile(target);
    assertDigestMatches(asset.sha256, actual.sha256, `Release asset ${asset.name}`);
    if (actual.bytes <= 0) {
      fail(`Release asset ${asset.name} changed while staging.`);
    }
    asset.path = target;
    asset.bytes = actual.bytes;
  }
  return { manifest, releaseAssets, releases, rollbackTag };
}

async function claimAndVerifyDraft(
  token,
  expected,
  manifest,
  releaseAssets,
  priorReleases,
  rollbackTag,
  all,
) {
  const tag = manifest.releaseTag;
  const existing = await apiRequest(
    token,
    `/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (!existing.ok && existing.status !== 404) {
    fail(`Tag lookup failed with HTTP ${existing.status}; refusing an ambiguous promotion.`);
  }
  assertPromotionTagAvailable(
    existing.ok,
    priorReleases.some((release) => release.tag_name === tag),
  );
  const tagClaim = await apiRequest(token, `/repos/${REPOSITORY}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: expected.sourceSha }),
  });
  if (tagClaim.status !== 201) {
    fail(
      `Atomic tag claim failed with HTTP ${tagClaim.status}; preserve any claim and inspect it before retrying.`,
    );
  }
  const claimedRef = await apiJson(
    token,
    `/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (claimedRef.object?.sha !== expected.sourceSha || claimedRef.object?.type !== "commit") {
    fail(
      `Tag claim ${tag} does not point to the selected source; preserve it for manual recovery.`,
    );
  }
  gh([
    "release",
    "create",
    tag,
    ...releaseAssets.map((asset) => asset.path),
    "--repo",
    REPOSITORY,
    "--target",
    expected.sourceSha,
    "--verify-tag",
    "--draft",
    "--latest=false",
    "--title",
    `Paseo fork ${all.files.packageVersion} (${expected.sequence})`,
    "--notes",
    `Paired macOS and Android release for source ${expected.sourceSha}. Manifest is signed by ${PASEO_RELEASE_MANIFEST_KEY_ID}.`,
  ]);
  const draft = ghJson([
    "release",
    "view",
    tag,
    "--repo",
    REPOSITORY,
    "--json",
    "tagName,isDraft,targetCommitish,assets",
  ]);
  if (
    draft.tagName !== tag ||
    !draft.isDraft ||
    (draft.targetCommitish && draft.targetCommitish !== expected.sourceSha)
  ) {
    fail(
      `Draft ${tag} has an unexpected identity; preserve the tag and draft for manual recovery.`,
    );
  }
  const uploadedAssets = new Map(draft.assets.map((asset) => [asset.name, asset]));
  for (const asset of releaseAssets) {
    const uploaded = uploadedAssets.get(asset.name);
    if (
      !uploaded ||
      uploaded.size !== asset.bytes ||
      uploaded.digest !== `sha256:${asset.sha256}`
    ) {
      fail(
        `Uploaded draft asset ${asset.name} failed digest verification; preserve the draft for manual recovery.`,
      );
    }
  }
  if (uploadedAssets.size !== releaseAssets.length) {
    fail(`Draft ${tag} contains unexpected assets; preserve it for manual recovery.`);
  }
  return tag;
}

async function publishAndVerifyRelease(token, tag, manifest, releaseAssets, rollbackTag, baseDir) {
  const currentReleases = await listPriorReleases(token);
  const currentManifests = await verifiedPriorManifests(
    token,
    currentReleases,
    join(baseDir, "prior-releases-recheck"),
  );
  validateReleaseMonotonicity(manifest, currentManifests, rollbackTag);
  gh(["release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest=false"]);
  const published = ghJson([
    "release",
    "view",
    tag,
    "--repo",
    REPOSITORY,
    "--json",
    "tagName,isDraft,isImmutable,assets",
  ]);
  if (
    published.tagName !== tag ||
    published.isDraft ||
    published.assets.length !== releaseAssets.length
  ) {
    fail(`Published release ${tag} failed final verification; do not re-run automatically.`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "published", releaseTag: tag, sourceSha: manifest.sourceSha, releaseSequence: manifest.releaseSequence, androidVersionCode: manifest.android.versionCode, githubImmutable: published.isImmutable })}\n`,
  );
}

async function publish(options) {
  const { receipt } = await readReceipt(required(options, "receipt"));
  const expected = validateReceipt(receipt);
  const baseDir = assertSafeRelativePath(
    ROOT,
    receipt.stagingDirectory,
    "receipt staging directory",
  );
  const resolvedBase = await realpath(baseDir);
  if (!resolvedBase.startsWith(`${await realpath(WORK_DIR)}${sep}`)) {
    fail("Receipt staging directory resolves outside the promotion WIP directory.");
  }
  const token = getGitHubToken();
  const all = await revalidatePreparedArtifacts(token, receipt, expected, baseDir);
  const { manifest, releaseAssets, releases, rollbackTag } = await createReleasePayload(
    token,
    receipt,
    expected,
    all,
    baseDir,
    options,
  );
  const tag = await claimAndVerifyDraft(
    token,
    expected,
    manifest,
    releaseAssets,
    releases,
    rollbackTag,
    all,
  );
  await publishAndVerifyRelease(token, tag, manifest, releaseAssets, rollbackTag, baseDir);
}

async function copyFileNoOverwrite(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`Release input is not a regular file: ${source}`);
  }
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
}

export async function runPromotionCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "prepare") {
    await prepare(options);
    return;
  }
  await publish(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPromotionCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Promotion failed."}\n`);
    process.exitCode = 1;
  });
}
