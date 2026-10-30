// Writes the unsigned APK delta sidecars for release.yml: paseo-<v>-android-arm64.apk
// .delta-from-<prev>.zst, a zstd --patch-from delta of the signed APK against the signed
// APK of each of the last DELTA_BASE_RELEASES stable releases. The phone applies the one
// from its installed version to its installed APK (PaseoForkUpdatesModule.kt), checks the
// result against the signed manifest, and falls back to the .gz and then the APK.
// Usage: node release-android-delta.mjs <signed APK> <output dir>
// Env: VERSION, GITHUB_REPOSITORY, GH_TOKEN, RUNNER_TEMP; zstd on PATH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRange, hashFile, zstdDecompress } from "../../scripts/paseo-nix-update-delta.mjs";
import { latestVerifiedRelease, releaseDownloadUrl } from "../../scripts/paseo-nix-update.mjs";
import { DELTA_BASE_RELEASES, deltaBaseTags, listReleases } from "./release-mac-index.mjs";

// The phone decodes in one pass into the mapped output, which needs no window limit, but
// the encoder can only reach back this far into the base: 256 MiB covers MAX_APK_BYTES.
export const APK_WINDOW_LOG = 28;
// --ultra -22 gave 1.9 MB in 58 s for 0.13.0 -> 0.13.1, against 3.9 MB in 16 s at -19.
// --check: the phone detects a wrong base by the frame checksum.
const ZSTD_ARGS = ["-q", "--check", "--ultra", "-22", `--long=${APK_WINDOW_LOG}`];

export function apkDeltaAssetName(apkName, fromVersion) {
  assert.match(apkName, /^paseo-[0-9]+\.[0-9]+\.[0-9]+-android-arm64\.apk$/);
  assert.match(fromVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  return `${apkName}.delta-from-${fromVersion}.zst`;
}

function signedApk(manifest) {
  const apk = manifest.artifacts.find((artifact) => artifact.kind === "apk");
  assert.ok(apk, `${manifest.releaseTag} has no signed APK`);
  return apk;
}

/** Fetches a previous release's APK and checks it against that release's signed manifest. */
async function previousApk(tag, work) {
  const { manifest } = await latestVerifiedRelease({ resolveTag: async () => tag });
  const apk = signedApk(manifest);
  const file = join(work, "base.apk");
  const { sha256 } = await fetchRange(
    releaseDownloadUrl(tag, apk.name),
    { offset: 0, size: apk.bytes, total: apk.bytes },
    file,
  );
  assert.equal(sha256.toString("hex"), apk.sha256, `${tag} APK differs from its signed manifest`);
  return { version: manifest.version, bytes: apk.bytes, file };
}

/**
 * Creates the delta, proves it rebuilds the APK, and returns its size, or null when it
 * would not save at least half of the .gz download.
 */
export async function makeApkDelta({ base, next, directory, work, zstd = runZstd }) {
  const asset = apkDeltaAssetName(basename(next.file), base.version);
  if (Math.max(base.bytes, next.bytes) > 2 ** APK_WINDOW_LOG) {
    console.log(`Skipped the delta from ${base.version}: an APK exceeds the zstd window`);
    return null;
  }
  // Built and checked in the work directory, and moved to the upload directory only once it
  // passes: everything there is published.
  const file = join(work, asset);
  const check = join(work, "check.apk");
  try {
    await zstd([...ZSTD_ARGS, `--patch-from=${base.file}`, next.file, "-o", file]);
    const rebuilt = await zstdDecompress(file, check, next.bytes, { patchFrom: base.file });
    assert.ok(
      rebuilt.bytes === next.bytes && rebuilt.sha256.toString("hex") === next.sha256,
      `Delta from ${base.version} does not rebuild the APK`,
    );
    const { size } = await stat(file);
    if (size * 2 >= next.gzipBytes) {
      console.log(`Skipped the delta from ${base.version}: ${size} bytes saves too little`);
      return null;
    }
    await rename(file, join(directory, asset));
    console.log(`Delta from ${base.version}: ${size} bytes`);
    return size;
  } finally {
    await rm(file, { force: true });
    await rm(check, { force: true });
  }
}

async function runZstd(args) {
  const child = spawn("zstd", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  const code = await new Promise((settle, reject) => {
    child.on("error", reject);
    child.on("close", settle);
  });
  assert.equal(code, 0, `zstd failed: ${stderr}`);
}

async function main() {
  const [apkPath, directory] = process.argv.slice(2);
  const { VERSION: version } = process.env;
  assert.equal(basename(apkPath), `paseo-${version}-android-arm64.apk`);
  await mkdir(directory, { recursive: true });
  let tags = [];
  try {
    tags = deltaBaseTags(
      await listReleases(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
      version,
      DELTA_BASE_RELEASES,
    );
  } catch (error) {
    // Deltas only save bandwidth; release without them.
    console.log(`::warning::Could not list earlier releases for APK deltas: ${error.message}`);
  }
  const next = {
    file: apkPath,
    bytes: (await stat(apkPath)).size,
    sha256: (await hashFile(apkPath)).toString("hex"),
    gzipBytes: (await stat(`${apkPath}.gz`)).size,
  };
  const work = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-apk-delta-"));
  // One base per core at once: each --ultra -22 run is single-threaded, takes about
  // 90 s and peaks near 1.8 GB, so the four fit the runner's 4 cores and 16 GB.
  const made = [];
  try {
    await Promise.all(
      tags.map(async ({ tag }) => {
        const own = await mkdtemp(join(work, "base-"));
        try {
          const base = await previousApk(tag, own);
          if (await makeApkDelta({ base, next, directory, work: own })) made.push(base.version);
        } catch (error) {
          // Deltas only save bandwidth; a missing one must not block the release.
          console.log(`::warning::No APK delta from ${tag}: ${error.message}`);
        } finally {
          await rm(own, { recursive: true, force: true });
        }
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`APK deltas from ${made.join(", ") || "no earlier release"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
