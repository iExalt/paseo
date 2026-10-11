import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fetchCandidate, hashFile } from "./candidate-artifacts.mjs";
import {
  extractNixCacheTar,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  NIX_RELEASE_PUBLIC_KEY,
  validateNixClosureManifest,
  verifyReleaseManifestBytes,
} from "../../scripts/paseo-nix-update.mjs";

const predecessorSha = "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a";
const predecessorTag = `paseo-fork-v0.11.0-r200008-${predecessorSha}`;
const predecessorManifestHash = "c6b43a85ea107c5060dc85143b74ede6d9180082a5bd5b069e6171019ba1b599";
const options = [
  "--option",
  "builders",
  "",
  "--option",
  "substituters",
  "",
  "--option",
  "require-sigs",
  "true",
  "--option",
  "trusted-public-keys",
  NIX_RELEASE_PUBLIC_KEY,
];
const nix = (args) =>
  execFileSync("nix", args, { encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });

async function download(directory, name, maximum, expected) {
  assert.match(name, /^[a-zA-Z0-9._-]+$/);
  const file = join(directory, name);
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-redirs",
      "3",
      "--max-time",
      "120",
      "--max-filesize",
      String(maximum),
      `https://github.com/iExalt/paseo/releases/download/${predecessorTag}/${name}`,
      "--output",
      file,
    ],
    { timeout: 125000, stdio: "pipe" },
  );
  assert.ok((await stat(file)).size <= maximum);
  if (expected) {
    assert.equal((await stat(file)).size, expected.bytes);
    assert.equal(await hashFile(file), expected.sha256);
  }
  return file;
}

export function validateCandidateClosure(manifest, candidate) {
  assert.equal(manifest.kind, "paseo-verification-candidate");
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.platform, "macos-arm64");
  assert.ok(!Object.hasOwn(manifest, "releaseSequence"));
  assert.equal(manifest.sourceSha, candidate.sourceSha);
  assert.equal(manifest.forkVersion, candidate.forkVersion);
  assert.equal(manifest.packageVersion, candidate.forkVersion);
  assert.equal(manifest.system, "aarch64-darwin");
  assert.equal(manifest.lockHash, candidate.macOS.lockHash);
  assert.equal(manifest.outputPath, candidate.macOS.outputPath);
  assert.equal(manifest.provenance, "local-ci-build");
  assert.ok(
    Array.isArray(manifest.closure) &&
      manifest.closure.some(({ path }) => path === manifest.outputPath),
  );
}

async function materialize(archive, manifest, cache) {
  assert.match(manifest.outputPath, /^\/nix\/store\/[a-z0-9]{32}-[a-zA-Z0-9+._?=-]+$/);
  assert.ok(
    !existsSync(manifest.outputPath),
    "Fresh canonical store already contains candidate root",
  );
  await extractNixCacheTar(archive, cache);
  nix(localCacheCopyArgs(cache, manifest.outputPath));
  nix(localCacheCopySignaturesArgs(cache, manifest.outputPath));
  nix(["store", "verify", "--recursive", "--sigs-needed", "1", ...options, manifest.outputPath]);
  const info = JSON.parse(
    nix(["path-info", "--json", "--recursive", ...options, manifest.outputPath]),
  );
  const actual = Object.entries(info)
    .map(([path, value]) => ({ path, narHash: value.narHash, narSize: value.narSize }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    actual,
    manifest.closure,
    "Canonical imported closure differs from pinned manifest",
  );
  return join(manifest.outputPath, "Applications", "Paseo.app");
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(harnessSha, process.env.GITHUB_SHA);
  const pin = JSON.parse(process.env.CANDIDATE_PIN);
  const root = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-native-candidate-"));
  const artifacts = join(process.cwd(), ".dev/github-workflows/native/macos");
  await mkdir(artifacts, { recursive: true });
  try {
    const candidate = await fetchCandidate(
      pin,
      join(root, "candidate"),
      process.env.GH_TOKEN,
      "macos",
    );
    const candidateDir = join(root, "candidate/macos");
    const manifestBytes = await readFile(join(candidateDir, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    validateCandidateClosure(manifest, candidate);
    const previousDir = join(root, "previous");
    await mkdir(previousDir);
    const publishedFile = await download(previousDir, "paseo-release-manifest.json", 65536);
    assert.equal(await hashFile(publishedFile), predecessorManifestHash);
    const signatureFile = await download(previousDir, "paseo-release-manifest.sig", 1024);
    const published = verifyReleaseManifestBytes(
      await readFile(publishedFile),
      await readFile(signatureFile),
    );
    assert.equal(published.sourceSha, predecessorSha);
    assert.equal(published.releaseTag, predecessorTag);
    assert.equal(published.packageVersion, "0.11.0");
    assert.notEqual(published.macOS.outputPath, manifest.outputPath);
    assert.notEqual(published.packageVersion, candidate.forkVersion);
    const previousArchive = await download(
      previousDir,
      published.macOS.closureArchive.name,
      200 * 1024 * 1024,
      published.macOS.closureArchive,
    );
    const previousManifestFile = await download(
      previousDir,
      published.macOS.closureManifest.name,
      1024 * 1024,
      published.macOS.closureManifest,
    );
    const previousManifest = validateNixClosureManifest(
      await readFile(previousManifestFile),
      published,
    );
    const previousApp = await materialize(
      previousArchive,
      previousManifest,
      join(root, "previous-cache"),
    );
    const candidateCache = join(root, "candidate-cache");
    const candidateApp = await materialize(
      join(candidateDir, `${candidate.macOS.artifactName}.tar`),
      manifest,
      candidateCache,
    );
    nix(localCacheCopyArgs(candidateCache, candidate.macOS.manifestPath));
    assert.deepEqual(
      await readFile(candidate.macOS.manifestPath),
      manifestBytes,
      "Imported manifest byte mismatch",
    );
    await writeFile(
      join(artifacts, "identity.json"),
      JSON.stringify(
        {
          harnessSha,
          producer: pin,
          previous: {
            sourceSha: predecessorSha,
            version: published.packageVersion,
            outputPath: published.macOS.outputPath,
            archiveSha256: published.macOS.closureArchive.sha256,
          },
          candidate: {
            sourceSha: candidate.sourceSha,
            version: candidate.forkVersion,
            ...candidate.macOS,
          },
        },
        null,
        2,
      ),
    );
    const require = createRequire(import.meta.url);
    const {
      smokePackagedDesktopUpgrade,
    } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
    await smokePackagedDesktopUpgrade({ previousApp, candidateApp, artifactDir: artifacts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("/macos-candidate-runtime.mjs")) await main();
