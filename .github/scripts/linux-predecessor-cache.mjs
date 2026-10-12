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
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const previousSha = "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a";
export const cacheLimit = 650 * 1024 * 1024;
export const repositorySaveCeiling = 8_000_000_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (filename) => sha256(readFileSync(filename));
const filenames = (architecture) =>
  ["deb", "rpm", "AppImage"].map((ext) => `previous-${architecture}.${ext}`);

export function cacheKey(recipe) {
  return `paseo-linux-predecessor-v1-${recipe.architecture}-${sha256(JSON.stringify(recipe))}`;
}

export function validateCache(directory, recipe) {
  const expectedFiles = [...filenames(recipe.architecture), "receipt.json", "previous.json"].sort();
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
  assert.deepEqual(receipt.recipe, recipe, "Predecessor cache recipe mismatch");
  assert.match(receipt.producerSha, /^[a-f0-9]{40}$/);
  assert.match(receipt.runId, /^\d+$/);
  assert.match(receipt.attempt, /^\d+$/);
  assert.match(receipt.rpmScriptsSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.identitySha256, hashFile(join(directory, "previous.json")));
  const identity = JSON.parse(readFileSync(join(directory, "previous.json")));
  assert.equal(identity.sourceSha, previousSha);
  assert.equal(identity.lockHash, recipe.lockHash);
  assert.equal(identity.version, "0.11.0");
  assert.equal(identity.name, "@getpaseo/desktop");
  assert.equal(identity.desktopName, "Paseo.desktop");
  assert.deepEqual(Object.keys(identity.artifacts).sort(), ["appimage", "deb", "rpm"]);
  assert.deepEqual(
    Object.keys(identity.payload).sort(),
    ["Paseo", "Paseo.bin", "chrome-sandbox", "resources/app.asar", "resources/bin/paseo"].sort(),
  );
  for (const hash of Object.values(identity.payload)) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const [format, artifact] of Object.entries(identity.artifacts)) {
    const filename = `previous-${recipe.architecture}.${format === "appimage" ? "AppImage" : format}`;
    assert.equal(artifact.file, filename);
    assert.equal(lstatSync(join(directory, filename)).size, artifact.bytes);
    assert.equal(hashFile(join(directory, filename)), artifact.sha256, `Corrupt cached ${format}`);
  }
  assert.equal(identity.artifacts.deb.packageName, "paseo");
  assert.equal(identity.artifacts.rpm.packageName, "Paseo");
  assert.match(identity.artifacts.appimage.appRunSha256, /^[a-f0-9]{64}$/);
  return { receipt, identity, bytes };
}

function validatePackageMetadata(directory, recipe) {
  const rpm = join(directory, `previous-${recipe.architecture}.rpm`);
  const scripts = execFileSync("rpm", ["-qp", "--scripts", rpm], { encoding: "utf8" });
  assert.ok(scripts.includes("postuninstall scriptlet"));
  assert.ok(scripts.includes("rm -f '/usr/bin/Paseo'"));
  assert.ok(
    !scripts.includes("posttrans scriptlet") && !scripts.includes("remaining-package count"),
    "Predecessor RPM removal behavior must remain historical",
  );
  const architecture = recipe.architecture === "arm64" ? "aarch64" : "x86_64";
  assert.equal(
    execFileSync("rpm", ["-qp", "--queryformat", "%{NAME} %{VERSION} %{ARCH}", rpm], {
      encoding: "utf8",
    }),
    `Paseo 0.11.0 ${architecture}`,
  );
  const deb = join(directory, `previous-${recipe.architecture}.deb`);
  const fields = {
    Package: "paseo",
    Version: "0.11.0",
    Architecture: recipe.architecture === "arm64" ? "arm64" : "amd64",
  };
  for (const [field, expected] of Object.entries(fields))
    assert.equal(
      execFileSync("dpkg-deb", ["-f", deb, field], { encoding: "utf8" }).trim(),
      expected,
    );
  return sha256(scripts);
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function recipeForRunner() {
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v26.11.0");
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
  return {
    schema: 1,
    sourceSha: previousSha,
    lockHash: sha256(lock),
    architecture: process.arch,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    node: "26.11.0",
    npm: "11.20.0",
    electron: "44.6.0",
    builder: "26.15.3",
    fpm: "1.17.0",
    overrides: { debCompression: "gz", rpmCompression: "gzip", legacyRpmScripts: "unchanged" },
    producers: Object.fromEntries(producers.map((file) => [file, hashFile(file)])),
  };
}

async function main() {
  const [operation, root] = process.argv.slice(2);
  const directory = join(process.env.RUNNER_TEMP, "paseo-predecessor-cache");
  const recipeFile = join(process.env.RUNNER_TEMP, "paseo-predecessor-recipe.json");
  if (operation === "prepare") {
    const recipe = recipeForRunner();
    writeFileSync(recipeFile, JSON.stringify(recipe));
    output("key", cacheKey(recipe));
    output("directory", directory);
    return;
  }
  const recipe = JSON.parse(readFileSync(recipeFile));
  if (operation === "restore") {
    assert.equal(
      process.env.PREDECESSOR_CACHE_MATCHED_KEY,
      cacheKey(recipe),
      "Only exact cache matches are accepted",
    );
    const started = Date.now();
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
      recipe,
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
  } else if (operation === "budget") {
    const { bytes } = validateCache(directory, recipe);
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
    const save = usage + cacheLimit <= repositorySaveCeiling;
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
