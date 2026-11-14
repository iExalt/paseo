// publishing. It stages the release the way the in-app updater does, with only
// the release key trusted and substituters disabled:
//   1. installs the newest earlier release through the full-tar path
//      (downloadAsset, client tar extractor);
//   2. stages this release through the partial path (prepareIndexedCache over
//      the local index, delta and tar), which must need only the desktop delta;
//   3. checks the full tar still verifies for clients that never read the index;
// then checks the bundle signature, the bundled CLI and updater, and launches
// the packaged app once. The launch's builtin-plugin check
// Usage: node release-mac-smoke.mjs <directory with tar, closure json, index and deltas>
// Env: VERSION, SOURCE_SHA, OUTPUT_PATH, PUBLISH, GITHUB_REPOSITORY, GH_TOKEN,
// PASEO_DESKTOP_SMOKE_ARTIFACT_DIR, RUNNER_TEMP; zstd on PATH.
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseNarinfo, prepareIndexedCache } from "../../scripts/paseo-nix-update-delta.mjs";
import { assertFreeSpace, downloadAsset } from "../../scripts/paseo-nix-update-legacy.mjs";
  verifiedReleaseForTag,
  macArtifact,
  releaseDownloadUrl,
import { deltaBaseTags, listReleases } from "./release-mac-index.mjs";

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
  const { manifest } = await verifiedReleaseForTag(previous.tag);
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
  const hash = createHash("sha256");
  await pipeline(createReadStream(tar), hash);
  const artifact = {
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

  await stageThroughIndex({
    directory,
    scratch,
    version,
    outputPath,
    closure,
    publish: process.env.PUBLISH === "true",
  });
  assertReleaseKeyOnly([outputPath], closure.closure);
  // The updater applies deltas with the zstd its wrapper puts on PATH.
  const zstdDir = wrapperZstdDir(await readFile(join(outputPath, "bin/paseo-nix-update"), "utf8"));
  console.log(`Updater zstd: ${run(join(zstdDir, "zstd"), ["--version"]).trim()}`);
