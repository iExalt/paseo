// Writes the unsigned update sidecars beside the macOS release tar for release.yml:
// paseo-<v>-macos-arm64-nix-desktop.index.json (tar member ranges and narinfos)
// and .delta-from-<prev>.zst, a zstd --patch-from delta of the desktop NAR
// against each of the last DELTA_BASE_RELEASES stable releases. The updater
// reads them through scripts/paseo-nix-update-delta.mjs.
// Usage: node release-mac-index.mjs <release dir>
// Env: VERSION, SOURCE_SHA, OUTPUT_PATH, GITHUB_REPOSITORY, GH_TOKEN; zstd on PATH.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareForkVersions,
  forkVersionFromTag,
} from "../../packages/protocol/src/fork-version.ts";
import {
  buildIndex,
  deltaAssetName,
  dumpPath,
  fetchRange,
  hashFile,
  indexAssetName,
  parseNarinfo,
  sha256File,
  validateIndex,
  ZSTD_WINDOW_LOG,
  walkTar,
  zstdDecompress,
} from "../../scripts/paseo-nix-update-delta.mjs";
import { fetchHttps } from "../../scripts/paseo-nix-update-legacy.mjs";
import {
  fetchMetadata,
  latestVerifiedRelease,
  macArtifact,
  releaseDownloadUrl,
  validateNixArtifactClosure,
  validateNixClosureManifest,
} from "../../scripts/paseo-nix-update.mjs";

// Installs this many releases behind can update by delta. Each costs CI about
// 15 s (range fetch of the old NAR, then a 1-2 s delta) and a few MB of assets.
export const DELTA_BASE_RELEASES = 4;

const sri = (digest) => `sha256-${digest.toString("base64")}`;

/** The newest stable releases below version, newest first. */
export function deltaBaseTags(releases, version, count = DELTA_BASE_RELEASES) {
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ tag: release.tag_name, version: forkVersionFromTag(release.tag_name) }))
    .filter((release) => release.version && compareForkVersions(release.version, version) < 0)
    .sort((a, b) => compareForkVersions(b.version, a.version))
    .slice(0, count);
}

export async function listReleases(repository, token) {
  const response = await fetchHttps(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.ok(response.ok, `GitHub returned HTTP ${response.status} listing releases`);
  return response.json();
}

// Releases before the index existed: walk the tar headers with range requests
// (64 KiB reads, so runs of small narinfo members cost one request).
async function locateByWalking(url, artifact, storePath) {
  let block = { offset: -1, bytes: Buffer.alloc(0) };
  const readAt = async (offset, length) => {
    const start = Math.floor(offset / 65536) * 65536;
    if (block.offset !== start) {
      const size = Math.min(65536, artifact.bytes - start);
      const response = await fetchHttps(url, { Range: `bytes=${start}-${start + size - 1}` });
      assert.equal(response.status, 206, `Range request returned HTTP ${response.status}`);
      block = { offset: start, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    const at = offset - start;
    if (at + length <= block.bytes.length) return block.bytes.subarray(at, at + length);
    const head = block.bytes.subarray(at);
    return Buffer.concat([head, await readAt(offset + head.length, length - head.length)]);
  };
  const wanted = `${storePath.slice(11, 43)}.narinfo`;
  const members = new Map();
  let narinfo = null;
  for await (const member of walkTar(readAt, artifact.bytes)) {
    members.set(member.name, member);
    if (member.name === wanted)
      narinfo = parseNarinfo((await readAt(member.offset, member.size)).toString("utf8"));
    if (narinfo && members.has(narinfo.url)) return { narinfo, member: members.get(narinfo.url) };
  }
  throw new Error(`${artifact.name} has no NAR for ${storePath}`);
}

/** Fetches a previous release's desktop NAR and checks it against that release's signed closure. */
async function previousNar(tag, work) {
  const { manifest } = await latestVerifiedRelease({ resolveTag: async () => tag });
  const artifact = macArtifact(manifest);
  const closure = validateNixClosureManifest(
    await fetchMetadata(
      releaseDownloadUrl(tag, artifact.closureManifest.name),
      "a closure manifest",
    ),
    manifest,
  );
  const entry = closure.closure.find(({ path }) => path === artifact.outputPath);
  const url = releaseDownloadUrl(tag, artifact.name);
  let located;
  try {
    const index = JSON.parse(
      await fetchMetadata(releaseDownloadUrl(tag, indexAssetName(artifact.name)), "an index"),
    );
    const checked = validateIndex(index, artifact, closure);
    const { info } = checked.narinfos.get(entry.path);
    located = { narinfo: info, member: checked.members.get(info.url) };
  } catch (error) {
    console.log(`${tag}: no usable index (${error.message}); walking its tar`);
    located = await locateByWalking(url, artifact, entry.path);
  }
  const compressed = join(work, "base.nar.zst");
  const file = join(work, "base.nar");
  const { sha256 } = await fetchRange(
    url,
    { ...located.member, total: artifact.bytes },
    compressed,
  );
  assert.equal(
    sha256File(sha256),
    located.narinfo.fileHash,
    `${tag} NAR differs from its FileHash`,
  );
  assert.equal(located.narinfo.compression, "zstd", `${tag} NAR is not zstd`);
  const nar = await zstdDecompress(compressed, file, entry.narSize);
  await rm(compressed);
  assert.ok(
    nar.bytes === entry.narSize && sri(nar.sha256) === entry.narHash,
    `${tag} NAR differs from its signed closure manifest`,
  );
  return { version: manifest.version, entry, file };
}

function zstd(args) {
  const result = spawnSync("zstd", args, { encoding: "utf8" });
  assert.ok(!result.error && result.status === 0, `zstd failed: ${result.stderr ?? result.error}`);
}

/** Creates the delta, proves it rebuilds the new NAR, and returns its index entry. */
async function makeDelta({ base, next, archiveName, directory, work }) {
  const asset = deltaAssetName(archiveName, base.version);
  const file = join(directory, asset);
  if (Math.max(base.entry.narSize, next.entry.narSize) > 2 ** ZSTD_WINDOW_LOG) {
    console.log(`Skipped the delta from ${base.version}: a NAR exceeds the zstd window`);
    return null;
  }
  // Default level 3: the 0.12.0 -> 0.12.1 spike gave 243 KB in 1.3 s; level 19
  // gave 520 KB in 95 s.
  zstd(["-q", `--long=${ZSTD_WINDOW_LOG}`, `--patch-from=${base.file}`, next.file, "-o", file]);
  const check = join(work, "check.nar");
  const rebuilt = await zstdDecompress(file, check, next.entry.narSize, { patchFrom: base.file });
  await rm(check);
  assert.equal(
    sri(rebuilt.sha256),
    next.entry.narHash,
    `Delta from ${base.version} does not rebuild the NAR`,
  );
  const { size } = await stat(file);
  if (size >= next.fileSize) {
    await rm(file);
    console.log(
      `Skipped the delta from ${base.version}: ${size} bytes is not below ${next.fileSize}`,
    );
    return null;
  }
  console.log(`Delta from ${base.version}: ${size} bytes`);
  return {
    fromPath: base.entry.path,
    fromNarHash: base.entry.narHash,
    toPath: next.entry.path,
    asset,
    bytes: size,
    sha256: (await hashFile(file)).toString("hex"),
  };
}

// Every NAR range the index names must hash to its narinfo FileHash.
async function checkRanges(archivePath, checked) {
  const handle = await open(archivePath, "r");
  try {
    for (const { info } of checked.narinfos.values()) {
      const member = checked.members.get(info.url);
      const bytes = Buffer.alloc(member.size);
      await handle.read(bytes, 0, member.size, member.offset);
      const digest = createHash("sha256").update(bytes).digest();
      assert.equal(sha256File(digest), info.fileHash, `${info.url} differs from its FileHash`);
    }
  } finally {
    await handle.close();
  }
}

async function main() {
  const [directory] = process.argv.slice(2);
  const { VERSION: version, SOURCE_SHA: sourceSha, OUTPUT_PATH: outputPath } = process.env;
  const base = `paseo-${version}-macos-arm64-nix-desktop`;
  const archiveName = `${base}.tar`;
  const archivePath = join(directory, archiveName);
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
  const index = await buildIndex(archivePath, archiveName);
  const artifact = { name: archiveName, ...index.archive };
  const checked = validateIndex(index, artifact, closure);
  await checkRanges(archivePath, checked);

  let tags = [];
  try {
    tags = deltaBaseTags(
      await listReleases(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
      version,
    );
  } catch (error) {
    // Deltas only save bandwidth; publish the index without them.
    console.log(`::warning::Could not list earlier releases for deltas: ${error.message}`);
  }
  const work = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-release-delta-"));
  try {
    const entry = closure.closure.find(({ path }) => path === outputPath);
    const next = {
      entry,
      file: join(work, "next.nar"),
      fileSize: checked.narinfos.get(outputPath).info.fileSize,
    };
    if (tags.length > 0) {
      await dumpPath(outputPath, next.file);
      assert.equal(
        sri(await hashFile(next.file)),
        entry.narHash,
        "Dumped NAR differs from the closure",
      );
    }
    for (const { tag } of tags) {
      try {
        const previous = await previousNar(tag, work);
        if (previous.entry.path === outputPath) continue;
        const delta = await makeDelta({ base: previous, next, archiveName, directory, work });
        if (delta) index.deltas.push(delta);
      } catch (error) {
        // Deltas only save bandwidth; a missing one must not block the release.
        console.log(`::warning::No delta from ${tag}: ${error.message}`);
      } finally {
        await rm(join(work, "base.nar"), { force: true });
        await rm(join(work, "base.nar.zst"), { force: true });
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  validateIndex(index, artifact, closure);
  const indexFile = join(directory, indexAssetName(archiveName));
  await writeFile(indexFile, `${JSON.stringify(index)}\n`, { flag: "wx" });
  console.log(
    `Wrote ${indexFile}: ${index.members.length} members, ${index.deltas.length} deltas from ${tags.map((t) => t.version).join(", ") || "no earlier release"}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
