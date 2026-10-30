// Fresh-runner smoke for the macOS release closure, run by release.yml before
// publishing. It stages the release the way the in-app updater does, with only
// the release key trusted and substituters disabled:
//   1. installs the newest earlier release through the full-tar path
//      (downloadAsset, client tar extractor);
//   2. stages this release through the partial path (prepareIndexedCache over
//      the local index, delta and tar), which must need only the desktop delta;
//   3. checks the full tar still verifies for clients that never read the index;
// then checks the bundle signature, the bundled CLI and updater, and launches
// the packaged app once. The launch's builtin-plugin check
// imports the client and server builds; they come from the closure's own app.asar,
// so the job installs only release-mac-smoke-deps.mjs and builds nothing.
// Usage: node release-mac-smoke.mjs <directory with tar, closure json, index and deltas>
// Env: VERSION, SOURCE_SHA, OUTPUT_PATH, PUBLISH, GITHUB_REPOSITORY, GH_TOKEN,
// PASEO_DESKTOP_SMOKE_ARTIFACT_DIR, RUNNER_TEMP; zstd on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseNarinfo, prepareIndexedCache } from "../../scripts/paseo-nix-update-delta.mjs";
import { assertFreeSpace, downloadAsset } from "../../scripts/paseo-nix-update-legacy.mjs";
import {
  extractNixCacheTar,
  latestVerifiedRelease,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  macArtifact,
  NIX_RELEASE_PUBLIC_KEY,
  releaseDownloadUrl,
  validateNixArtifactClosure,
} from "../../scripts/paseo-nix-update.mjs";
import { deltaBaseTags, listReleases } from "./release-mac-index.mjs";

const trustOnlyRelease = [
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
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 ** 2 });

// The release is not on GitHub before publish, so the partial path reads the
// local assets: a Range request gets an exact 206, anything else the whole file.
export function localReleaseFetch(directory) {
  let served = 0;
  async function fetchImpl(name, headers = {}) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Unexpected local asset name");
    const file = join(directory, name);
    const { size } = await stat(file);
    const range = /^bytes=([0-9]+)-([0-9]+)$/.exec(headers.Range ?? "");
    if (!range) {
      served += size;
      return new Response(Readable.toWeb(createReadStream(file)), { status: 200 });
    }
    const [start, end] = [Number(range[1]), Number(range[2])];
    assert.ok(start <= end && end < size, `Unsatisfiable range ${headers.Range}`);
    served += end - start + 1;
    return new Response(Readable.toWeb(createReadStream(file, { start, end })), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  return { fetchImpl, served: () => served };
}

/**
 * Checks that an install of the previous release stages this one with the
 * desktop path from its delta; any other missing path must come from a tar
 * range, which exercises that path on real Nix too. Without the delta a dry
 * run fails; a publish warns and returns false, and the smoke still imports
 * the partial-path cache.
 */
export function checkDeltaPlan({
  index,
  plan,
  outputPath,
  basePath,
  desktopFileSize,
  served,
  tarBytes,
  publish,
  warn,
  log = console.log,
}) {
  const listed = index.deltas.some(
    (delta) => delta.fromPath === basePath && delta.toPath === outputPath,
  );
  if (!basePath || !listed) {
    const message = `The update index has no delta from ${basePath ?? "an earlier release"}`;
    if (!publish) throw new Error(message);
    warn(message);
    return false;
  }
  const desktop = plan.filter((step) => step.entry.path === outputPath);
  assert.ok(
    desktop.length === 1 && desktop[0].delta?.fromPath === basePath,
    "The desktop path should come from the previous release's delta",
  );
  const { bytes } = desktop[0].delta;
  assert.ok(
    bytes < desktopFileSize * 0.1,
    `The desktop delta is ${bytes} bytes against a ${desktopFileSize}-byte compressed NAR`,
  );
  for (const step of plan) {
    if (step === desktop[0]) continue;
    assert.ok(step.narinfo && !step.delta, `${step.entry.path} should come from a tar range`);
    log(`${step.entry.path}: tar range of ${step.narinfo.fileSize} bytes`);
  }
  assert.ok(served < tarBytes, `Partial staging served ${served} of ${tarBytes} bytes`);
  return true;
}

/** The zstd directory makeWrapper --prefix put on the updater's PATH. */
export function wrapperZstdDir(wrapper) {
  const match = /\/nix\/store\/[0-9a-z]{32}-zstd-[^/'":\s]+\/bin/.exec(wrapper);
  assert.ok(match, "The updater wrapper puts no zstd on PATH");
  return match[0];
}

// Installs the newest earlier stable release through the updater's full path.
async function seedPreviousRelease(scratch, version) {
  const [previous] = deltaBaseTags(
    await listReleases(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
    version,
  );
  assert.ok(previous, "There is no earlier stable release");
  const { manifest } = await latestVerifiedRelease({ resolveTag: async () => previous.tag });
  const artifact = macArtifact(manifest);
  const file = join(scratch, artifact.name);
  await downloadAsset(
    {
      name: artifact.name,
      url: releaseDownloadUrl(previous.tag, artifact.name),
      size: artifact.bytes,
    },
    file,
    {
      expectedBytes: artifact.bytes,
      expectedSha256: artifact.sha256,
      maxBytes: artifact.bytes,
      signal: AbortSignal.timeout(600_000),
    },
  );
  const cache = join(scratch, "previous-cache");
  await extractNixCacheTar(file, cache);
  run("nix", localCacheCopyArgs(cache, artifact.outputPath));
  run("nix", localCacheCopySignaturesArgs(cache, artifact.outputPath));
  await rm(file);
  await rm(cache, { recursive: true, force: true });
  console.log(`Installed ${previous.tag} (${artifact.outputPath}) from its full tar`);
  return artifact.outputPath;
}

/** Steps 1-3 of the header; leaves this release imported into the store. */
export async function stageThroughIndex({
  directory,
  scratch,
  version,
  outputPath,
  closure,
  publish,
}) {
  const warn = (message) => console.log(`::warning::${message}`);
  let basePath = null;
  try {
    basePath = await seedPreviousRelease(scratch, version);
  } catch (error) {
    if (!publish) throw error;
    warn(`Could not install the previous release: ${error.message}`);
  }
  const base = `paseo-${version}-macos-arm64-nix-desktop`;
  const tar = join(directory, `${base}.tar`);
  const hash = createHash("sha256");
  await pipeline(createReadStream(tar), hash);
  const artifact = {
    name: `${base}.tar`,
    bytes: (await stat(tar)).size,
    sha256: hash.digest("hex"),
  };
  const local = localReleaseFetch(directory);
  const indexed = join(scratch, "indexed");
  await mkdir(indexed);
  const { cache, plan, transferred } = await prepareIndexedCache({
    tag: "unpublished",
    artifact,
    closure,
    directory: indexed,
    downloadUrl: (_tag, name) => name,
    fetchBytes: (name) => readFile(join(directory, name)),
    freeSpace: (transferBytes, importBytes) => assertFreeSpace(transferBytes, importBytes, scratch),
    fetchImpl: local.fetchImpl,
  });
  // The updater reads the index through fetchBytes, outside the shim.
  const indexBytes = await readFile(join(directory, `${base}.index.json`));
  const index = JSON.parse(indexBytes.toString("utf8"));
  const served = local.served() + indexBytes.length;
  console.log(
    `Partial staging: ${served} bytes served (${transferred} counted by the updater) of a ${artifact.bytes}-byte tar; plan ${plan
      .map((step) => `${step.entry.path} via ${step.delta ? step.delta.asset : "tar range"}`)
      .join(", ")}`,
  );
  const desktopFileSize = index.narinfos
    .map(parseNarinfo)
    .find((info) => info.storePath === outputPath).fileSize;
  checkDeltaPlan({
    index,
    plan,
    outputPath,
    basePath,
    desktopFileSize,
    served,
    tarBytes: artifact.bytes,
    publish,
    warn,
  });
  run("nix", localCacheCopyArgs(cache, outputPath));
  run("nix", localCacheCopySignaturesArgs(cache, outputPath));
  await rm(indexed, { recursive: true, force: true });

  // Clients that never read the index import the full tar: it must verify too.
  const full = join(scratch, "full-cache");
  await extractNixCacheTar(tar, full);
  run("nix", [
    "store",
    "verify",
    "--store",
    `file://${full}`,
    "--recursive",
    "--sigs-needed",
    "1",
    ...trustOnlyRelease,
    outputPath,
  ]);
  await rm(full, { recursive: true, force: true });
  console.log("The full tar verifies with only the release key");
}

// The bundle must keep the signature the build applied through NAR packing and
// substitution; macOS refuses notifications from a bundle signed as Electron.
function assertPaseoSignature(app) {
  const codesign = (args) => {
    const result = spawnSync("/usr/bin/codesign", [...args, app], { encoding: "utf8" });
    assert.equal(result.status, 0, `codesign ${args[0]} failed: ${result.stderr}`);
    return result.stderr;
  };
  codesign(["--verify", "--deep", "--strict"]);
  assert.match(codesign(["--display", "--verbose=2"]), /^Identifier=sh\.paseo\.desktop$/m);
}

// Links the client and server builds packed in app.asar to where
// packaged-app-smoke.js imports them from the checkout.
export async function linkClosureBuilds(app, repoRoot, scratch) {
  const { extractAll } = await import("@electron/asar");
  const archive = join(app, "Contents/Resources/app.asar");
  const extracted = join(scratch, "app");
  const links = [
    [
      join(extracted, "node_modules/@getpaseo/client"),
      join(repoRoot, "node_modules/@getpaseo/client"),
    ],
    [join(extracted, "node_modules/@getpaseo/server/dist"), join(repoRoot, "packages/server/dist")],
  ];
  // A clean checkout has neither; never replace a developer's builds.
  for (const [, link] of links) {
    assert.throws(() => lstatSync(link), { code: "ENOENT" }, `${link} already exists`);
  }
  try {
    extractAll(archive, extracted);
  } catch (error) {
    // The asar header still lists unpacked prebuilds the closure omits (other
    // platforms' node-pty, the agent SDK binary); only those may be missing.
    // asar joins each collected error's stack with blank lines after this header.
    const [head, ...failures] = String(error.message).split("\n\n");
    const expected = `Error: ENOENT: no such file or directory, open '${archive}.unpacked/`;
    if (
      head !== "Unable to extract some files:" ||
      !failures.length ||
      failures.some((stack) => !stack.startsWith(expected))
    ) {
      throw error;
    }
    console.log(
      `Extracted app.asar; ${failures.length} listed unpacked files are not in the closure`,
    );
  }
  for (const file of [
    "node_modules/@getpaseo/client/dist/daemon-client.js",
    "node_modules/@getpaseo/server/dist/server/server/plugins/builtin/index.js",
  ]) {
    assert.ok(existsSync(join(extracted, file)), `app.asar has no ${file}`);
  }
  for (const [target, link] of links) {
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  return links;
}

/**
 * Checks that the imported outputs verify with only the release key, that an
 * unrelated key does not, and that their closure matches the manifest's.
 */
export function assertReleaseKeyOnly(outputPaths, closure) {
  // A daemon that ignores client trust options would fall back to its own keys,
  // so first prove the options bind: another key must not verify the closure.
  const verify = (trusted) =>
    spawnSync(
      "nix",
      [
        "store",
        "verify",
        "--recursive",
        "--sigs-needed",
        "1",
        ...trustOnlyRelease.slice(0, -1),
        trusted,
        ...outputPaths,
      ],
      { encoding: "utf8", timeout: 600_000 },
    );
  const secret = run("nix", ["key", "generate-secret", "--key-name", "paseo-negative-control"]);
  const other = execFileSync("nix", ["key", "convert-secret-to-public"], {
    input: secret,
    encoding: "utf8",
  }).trim();
  const control = verify(other);
  assert.notEqual(control.status, 0, "The closure verified under an unrelated key");
  assert.match(control.stderr, /lacks a signature|untrusted|signature/i, control.stderr);
  const real = verify(NIX_RELEASE_PUBLIC_KEY);
  assert.equal(real.status, 0, `Release key verification failed: ${real.stderr}`);
  for (const result of [control, real])
    assert.doesNotMatch(result.stderr, /ignoring the client-specified setting/);
  const imported = Object.entries(
    JSON.parse(
      run("nix", ["path-info", "--json", "--recursive", ...trustOnlyRelease, ...outputPaths]),
    ),
  )
    .map(([path, info]) => ({ path, narHash: info.narHash, narSize: info.narSize }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(imported, closure, "Imported closure differs from its manifest");
  console.log(`Imported ${imported.length} signed store paths with only the release key`);
}

async function main() {
  const [directory] = process.argv.slice(2);
  const { VERSION: version, SOURCE_SHA: sourceSha, OUTPUT_PATH: outputPath } = process.env;
  assert.equal(process.platform, "darwin");
  const base = `paseo-${version}-macos-arm64-nix-desktop`;
  const closureBytes = await readFile(join(directory, `${base}.json`));
  const closure = validateNixArtifactClosure(
    closureBytes,
    {
      system: "aarch64-darwin",
      outputPath,
      closureManifest: {
        bytes: closureBytes.length,
        sha256: createHash("sha256").update(closureBytes).digest("hex"),
      },
    },
    { sourceSha, version },
  );
  assert.ok(!existsSync(outputPath), "A fresh runner must not already hold the release output");

  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-release-"));
  await stageThroughIndex({
    directory,
    scratch,
    version,
    outputPath,
    closure,
    publish: process.env.PUBLISH === "true",
  });
  assertReleaseKeyOnly([outputPath], closure.closure);

  const app = join(outputPath, "Applications", "Paseo.app");
  assertPaseoSignature(app);
  const cliVersion = run(join(app, "Contents/Resources/bin/paseo"), ["--version"]).trim();
  assert.ok(cliVersion.split("\n").includes(version), `Bundled CLI reports ${cliVersion}`);
  assert.match(
    run(join(outputPath, "bin/paseo-nix-update"), ["--help"]),
    /^Usage: paseo-nix-update/,
  );
  // The updater applies deltas with the zstd its wrapper puts on PATH.
  const zstdDir = wrapperZstdDir(await readFile(join(outputPath, "bin/paseo-nix-update"), "utf8"));
  console.log(`Updater zstd: ${run(join(zstdDir, "zstd"), ["--version"]).trim()}`);
  console.log(`Bundle signed as sh.paseo.desktop; bundled CLI ${cliVersion}; updater runs`);

  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
  const links = await linkClosureBuilds(app, root, scratch);
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    join(artifactDir, "provenance.txt"),
    links.map(([target, link]) => `${link} -> ${target} (from ${outputPath} app.asar)\n`).join(""),
  );
  const require = createRequire(import.meta.url);
  const { smokePackagedDesktopApp } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
  // Writes its artifacts to PASEO_DESKTOP_SMOKE_ARTIFACT_DIR as well.
  await smokePackagedDesktopApp({ appPath: app });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
