import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAttested, verifyBuildCache, writeExactArchive } from "./build-cache-provenance.mjs";

export const previousSha = "b6e0474aec58b2c169f61b81b20de890d4138e30";
// Bump when a change alters the reconstructed predecessor's bytes; the key
// deliberately ignores producer scripts and the runner image version.
export const predecessorFormat = 1;
// Only a dispatch of this workflow on dev writes the entry, attested like the
// Windows caches; candidates install the predecessor packages as root.
export const writer = "linux-product-runtime.yml";
export const cacheLimit = 650 * 1024 * 1024;
export const repositorySaveCeiling = 8_000_000_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (filename) => sha256(readFileSync(filename));
const filenames = (architecture) =>
  ["deb", "rpm", "AppImage"].map((ext) => `previous-${architecture}.${ext}`);
const inventory = (recipe) =>
  [...filenames(recipe.architecture), "receipt.json", "previous.json"].sort();

export function cacheKey(recipe) {
  return `paseo-linux-predecessor-v2-${recipe.architecture}-${sha256(JSON.stringify(recipe))}`;
}

// The key holds exactly what defines the fixture; diagnostics only explain it.
export function predecessorRecipe(runner) {
  return {
    key: {
      schema: 2,
      predecessorFormat,
      sourceSha: previousSha,
      version: "0.1.0",
      name: "@getpaseo/desktop",
      desktopName: "Paseo.desktop",
      debPackageName: "paseo",
      rpmPackageName: "Paseo",
      lockHash: runner.lockHash,
      architecture: runner.architecture,
      // fpm drives the image's dpkg-deb and the apt-installed rpmbuild, which are
      // not pinned; imageOS bounds them without keying on every image release.
      imageOS: runner.imageOS,
      node: "26.11.1",
      npm: "11.20.0",
      electron: "44.6.0",
      builder: "26.15.3",
      fpm: "1.17.0",
      overrides: { debCompression: "gz", rpmCompression: "gzip", legacyRpmScripts: "unchanged" },
    },
    diagnostics: { imageVersion: runner.imageVersion, producers: runner.producers },
  };
}

export function validateCache(directory, recipe) {
  const expectedFiles = inventory(recipe);
  assert.deepEqual(
    readdirSync(directory).sort(),
    expectedFiles,
    "Unexpected predecessor cache contents",
  );
  let bytes = 0;
  for (const file of expectedFiles) {
    const stat = lstatSync(join(directory, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Only regular cache files are accepted");
    bytes += stat.size;
  }
  assert.ok(bytes <= cacheLimit, "Predecessor cache exceeds 650 MiB");
  const receipt = JSON.parse(readFileSync(join(directory, "receipt.json")));
  assert.deepEqual(receipt.key, recipe, "Predecessor cache recipe mismatch");
  assert.ok(
    receipt.diagnostics !== null &&
      typeof receipt.diagnostics === "object" &&
      !Array.isArray(receipt.diagnostics),
    "Predecessor diagnostics object required",
  );
  assert.match(receipt.producerSha, /^[a-f0-9]{40}$/);
  assert.match(receipt.runId, /^\d+$/);
  assert.match(receipt.attempt, /^\d+$/);
  assert.match(receipt.rpmScriptsSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.identitySha256, hashFile(join(directory, "previous.json")));
  const identity = JSON.parse(readFileSync(join(directory, "previous.json")));
  assert.equal(identity.sourceSha, recipe.sourceSha);
  assert.equal(identity.lockHash, recipe.lockHash);
  assert.equal(identity.version, recipe.version);
  assert.equal(identity.name, recipe.name);
  assert.equal(identity.desktopName, recipe.desktopName);
  assert.deepEqual(Object.keys(identity.artifacts).sort(), ["appimage", "deb", "rpm"]);
  assert.deepEqual(
    Object.keys(identity.payload).sort(),
    [
      "Paseo",
      "Paseo.bin",
      "chrome-sandbox",
      "resources/app.asar",
      "resources/bin/paseo",
      "resources/linux-after-install.sh",
    ].sort(),
  );
  for (const hash of Object.values(identity.payload)) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const [format, artifact] of Object.entries(identity.artifacts)) {
    const filename = `previous-${recipe.architecture}.${format === "appimage" ? "AppImage" : format}`;
    assert.equal(artifact.file, filename);
    assert.equal(lstatSync(join(directory, filename)).size, artifact.bytes);
    assert.equal(hashFile(join(directory, filename)), artifact.sha256, `Corrupt cached ${format}`);
  }
  assert.equal(identity.artifacts.deb.packageName, recipe.debPackageName);
  assert.equal(identity.artifacts.rpm.packageName, recipe.rpmPackageName);
  assert.match(identity.artifacts.appimage.appRunSha256, /^[a-f0-9]{64}$/);
  return { receipt, identity, bytes };
}

function validatePackageMetadata(directory, recipe) {
  const rpm = join(directory, `previous-${recipe.architecture}.rpm`);
  const scripts = execFileSync("rpm", ["-qp", "--scripts", rpm], { encoding: "utf8" });
  assert.ok(scripts.includes("postuninstall scriptlet"));
  assert.ok(
    scripts.includes("posttrans scriptlet") && scripts.includes("remaining-package count"),
    "The 0.1.0 predecessor must retain its upgrade-safe RPM hooks",
  );
  const architecture = recipe.architecture === "arm64" ? "aarch64" : "x86_64";
  assert.equal(
    execFileSync("rpm", ["-qp", "--queryformat", "%{NAME} %{VERSION} %{ARCH}", rpm], {
      encoding: "utf8",
    }),
    `${recipe.rpmPackageName} ${recipe.version} ${architecture}`,
  );
  const deb = join(directory, `previous-${recipe.architecture}.deb`);
  const fields = {
    Package: recipe.debPackageName,
    Version: recipe.version,
    Architecture: recipe.architecture === "arm64" ? "arm64" : "amd64",
  };
  for (const [field, expected] of Object.entries(fields))
    assert.equal(
      execFileSync("dpkg-deb", ["-f", deb, field], { encoding: "utf8" }).trim(),
      expected,
    );
  return sha256(scripts);
}

const archiveShape = (recipe) => ({ inventory: inventory(recipe), limit: cacheLimit, tar: "tar" });

export function writeArchive(directory, archive, recipe) {
  validateCache(directory, recipe);
  return writeExactArchive(directory, archive, archiveShape(recipe));
}

// Any failure is a miss: the extracted directory goes so the rebuild stages cleanly.
export async function verifyArchive({ archive, directory }, loadRecipe, verify) {
  try {
    const recipe = loadRecipe();
    const archiveSha256 = await extractAttested(
      archive,
      directory,
      { key: cacheKey(recipe), writer, ...archiveShape(recipe) },
      verify,
    );
    validateCache(directory, recipe);
    return { verified: true, archiveSha256 };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    return { verified: false, error };
  } finally {
    rmSync(archive, { force: true });
  }
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function recipeForRunner() {
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v26.11.1");
  assert.equal(execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), "11.20.0");
  assert.ok(["x64", "arm64"].includes(process.arch));
  assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
  assert.ok(process.env.ImageOS && process.env.ImageVersion, "Hosted image identity required");
  const lock = execFileSync("git", ["show", `${previousSha}:package-lock.json`], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const locked = JSON.parse(lock);
  assert.equal(locked.packages["node_modules/electron"].version, "44.6.0");
  assert.equal(locked.packages["node_modules/electron-builder"].version, "26.15.3");
  const producers = [
    ".github/scripts/linux-product-build.sh",
    ".github/scripts/linux-product-package.mjs",
    ".github/scripts/linux-predecessor-cache.mjs",
    "packages/desktop/e2e/linux-installed-layout.cjs",
    ".github/workflows/linux-product-runtime.yml",
  ];
  return predecessorRecipe({
    lockHash: sha256(lock),
    architecture: process.arch,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    producers: Object.fromEntries(producers.map((file) => [file, hashFile(file)])),
  });
}

async function main() {
  const [operation, root] = process.argv.slice(2);
  const directory = join(process.env.RUNNER_TEMP, "paseo-predecessor-cache");
  const archive = join(process.env.RUNNER_TEMP, "paseo-linux-predecessor.tar");
  const recipeFile = join(process.env.RUNNER_TEMP, "paseo-predecessor-recipe.json");
  if (operation === "prepare") {
    const { key: recipe, diagnostics } = recipeForRunner();
    writeFileSync(recipeFile, JSON.stringify({ key: recipe, diagnostics }));
    output("key", cacheKey(recipe));
    output("archive", archive);
    console.log(JSON.stringify({ key: cacheKey(recipe), diagnostics }));
    return;
  }
  const loadRecipe = () => {
    const saved = JSON.parse(readFileSync(recipeFile));
    assert.deepEqual(saved.key, recipeForRunner().key);
    return saved;
  };
  if (operation === "verify") {
    const result = await verifyArchive(
      { archive, directory },
      () => {
        const { key: recipe } = loadRecipe();
        assert.equal(
          process.env.PREDECESSOR_CACHE_MATCHED_KEY,
          cacheKey(recipe),
          "Only exact cache matches are accepted",
        );
        return recipe;
      },
      verifyBuildCache,
    );
    output("verified", String(result.verified));
    if (result.verified) console.log(`Verified predecessor archive ${result.archiveSha256}`);
    else
      console.log(
        `::warning::Predecessor cache entry was rejected (${result.error.message}); rebuilding it.`,
      );
    return;
  }
  const { key: recipe, diagnostics } = loadRecipe();
  if (operation === "self-verify") {
    // The writer proves its own attestation verifies before any candidate needs it.
    const archiveSha256 = await verifyBuildCache(archive, { key: cacheKey(recipe), writer });
    console.log(`Writer attestation verifies for ${archiveSha256}`);
  } else if (operation === "restore") {
    const started = Date.now();
    const copies = [
      ...filenames(recipe.architecture).map((file) => join(root, "packages", file)),
      join(root, "previous.json"),
      join(root, "evidence/predecessor-cache.json"),
    ];
    try {
      const validated = validateCache(directory, recipe);
      assert.equal(validatePackageMetadata(directory, recipe), validated.receipt.rpmScriptsSha256);
      for (const file of filenames(recipe.architecture))
        copyFileSync(join(directory, file), join(root, "packages", file));
      copyFileSync(join(directory, "previous.json"), join(root, "previous.json"));
      writeFileSync(
        join(root, "evidence/predecessor-cache.json"),
        JSON.stringify({
          hit: true,
          key: cacheKey(recipe),
          validationMs: Date.now() - started,
          ...validated,
        }),
      );
    } catch (error) {
      // The build script rebuilds after a rejection, so leave nothing behind.
      for (const file of copies) rmSync(file, { force: true });
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  } else if (operation === "stage") {
    mkdirSync(directory, { recursive: true });
    assert.deepEqual(
      readdirSync(directory),
      [],
      "Refusing to replace unexpected restored cache data",
    );
    const rpmScriptsSha256 = validatePackageMetadata(join(root, "packages"), recipe);
    for (const file of filenames(recipe.architecture))
      copyFileSync(join(root, "packages", file), join(directory, file));
    copyFileSync(join(root, "previous.json"), join(directory, "previous.json"));
    const receipt = {
      key: recipe,
      diagnostics,
      producerSha: process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      identitySha256: hashFile(join(directory, "previous.json")),
      rpmScriptsSha256,
    };
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt));
    const validated = validateCache(directory, recipe);
    writeFileSync(
      join(root, "evidence/predecessor-cache.json"),
      JSON.stringify({ hit: false, key: cacheKey(recipe), ...validated }),
    );
  } else if (operation === "archive") {
    assert.equal(
      process.env.GITHUB_EVENT_NAME,
      "workflow_dispatch",
      "Only dispatched writers archive",
    );
    assert.equal(
      process.env.GITHUB_WORKFLOW_REF,
      `iExalt/paseo/.github/workflows/${writer}@refs/heads/dev`,
    );
    console.log(
      `Archived the verified predecessor (${writeArchive(directory, archive, recipe)} bytes)`,
    );
  } else if (operation === "budget") {
    const bytes = statSync(archive).size;
    let usage;
    try {
      usage = JSON.parse(
        execFileSync("gh", ["api", "repos/iExalt/paseo/actions/cache/usage"], {
          encoding: "utf8",
          timeout: 15000,
        }),
      ).active_caches_size_in_bytes;
      assert.ok(Number.isSafeInteger(usage) && usage >= 0);
    } catch {
      console.log("Cache usage unavailable; predecessor remains usable but will not be cached.");
      output("save", "false");
      return;
    }
    const save = bytes <= cacheLimit && usage + cacheLimit <= repositorySaveCeiling;
    console.log(
      JSON.stringify({
        usage,
        bytes,
        reserve: cacheLimit,
        save,
        advisory: "Concurrent cache writers can race; repository hard limit still applies.",
      }),
    );
    output("save", String(save));
  } else throw new Error(`Unknown cache operation: ${operation}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
