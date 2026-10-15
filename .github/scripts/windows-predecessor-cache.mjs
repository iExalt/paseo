import assert from "node:assert/strict";
import { assertNativeActor } from "./native-candidate-authority.mjs";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchiveListing, verifyBuildCache } from "./build-cache-provenance.mjs";
import { bindingProvenance, digest } from "./windows-speech-binding.mjs";
import { loadWindowsSources } from "./windows-product-sources.mjs";

export const previousSha = "b6e0474aec58b2c169f61b81b20de890d4138e30";
// Bump when a change alters the reconstructed predecessor's bytes; the key
// deliberately ignores producer scripts and the runner image version.
export const predecessorFormat = 1;
// Only a dispatched dev run writes the entry, attested like the modules cache;
// the installer runs in candidate jobs that hold id-token: write.
export const writer = "windows-product-runtime.yml";
export const cacheLimit = 200 * 1024 * 1024;
export const repositorySaveCeiling = 8_000_000_000;
const hash = (filename) => digest(readFileSync(filename));
const json = (filename) => JSON.parse(readFileSync(filename));
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value), { flag: "wx" });
const installerName = (recipe) => `previous-${recipe.architecture}.exe`;
const inventory = (recipe) => [installerName(recipe), "previous.json", "receipt.json"].sort();
export const lockIdentity = (blob, checkoutFile) => ({
  lockBlobSha256: digest(blob),
  lockSha256: hash(checkoutFile),
});
export const cacheKey = (recipe) =>
  `paseo-windows-predecessor-v2-${recipe.architecture}-${digest(JSON.stringify(recipe))}`;

// The key holds exactly what defines the fixture; diagnostics only explain it.
export function predecessorRecipe(runner) {
  return {
    key: {
      schema: 2,
      predecessorFormat,
      sourceSha: previousSha,
      version: "0.1.0",
      appId: "sh.paseo.desktop",
      ...runner.lock,
      architecture: runner.architecture,
      imageOS: runner.imageOS,
      node: "26.11.0",
      npm: "11.20.0",
      electron: "44.6.0",
      builder: "26.15.3",
      archiveFilter: "BCJ",
      bindingProvenance: runner.architecture === "arm64" ? runner.bindingProvenance : null,
    },
    diagnostics: {
      imageVersion: runner.imageVersion,
      producers: runner.producers,
      compiler: runner.compiler ?? null,
    },
  };
}

export function validateCache(directory, recipe) {
  const names = inventory(recipe);
  assert.deepEqual(
    readdirSync(directory).sort(),
    names,
    "Exact predecessor cache inventory required",
  );
  let bytes = 0;
  for (const name of names) {
    const stat = lstatSync(join(directory, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Regular cache files required");
    bytes += stat.size;
  }
  assert.ok(bytes <= cacheLimit, "Predecessor cache exceeds 200 MiB");
  const receipt = json(join(directory, "receipt.json"));
  assert.deepEqual(receipt.key, recipe, "Predecessor recipe mismatch");
  assert.ok(
    receipt.diagnostics !== null &&
      typeof receipt.diagnostics === "object" &&
      !Array.isArray(receipt.diagnostics),
    "Predecessor diagnostics object required",
  );
  assert.match(receipt.producerSha, /^[a-f0-9]{40}$/);
  assert.match(receipt.runId, /^\d+$/);
  assert.match(receipt.attempt, /^\d+$/);
  assert.equal(receipt.identitySha256, hash(join(directory, "previous.json")));
  const identity = json(join(directory, "previous.json"));
  assert.equal(identity.sourceSha, recipe.sourceSha);
  assert.equal(identity.lockSha256, recipe.lockSha256);
  assert.equal(identity.version, recipe.version);
  assert.equal(identity.architecture, recipe.architecture);
  assert.equal(identity.appId, recipe.appId);
  assert.equal(identity.archiveFilter, recipe.archiveFilter);
  assert.equal(
    identity.reconstruction,
    "Fixed source rebuilt with documented current binding and NSIS assembly",
  );
  assert.deepEqual(
    Object.keys(identity.payload).sort(),
    [
      "Paseo.exe",
      "resources/app.asar",
      "resources/bin/paseo.cmd",
      "resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
    ].sort(),
  );
  for (const value of Object.values(identity.payload)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(identity.binding.architecture, recipe.architecture);
  assert.equal(identity.binding.sherpa, "1.13.8");
  if (recipe.architecture === "arm64") {
    assert.deepEqual(identity.binding.provenance, recipe.bindingProvenance);
    assert.equal(identity.binding.electron, recipe.electron);
    assert.equal(identity.binding.onnxruntime, "1.28.2");
  } else assert.equal(identity.binding.source, "locked sherpa-onnx-win-x64 package");
  const files = identity.binding.files;
  assert.equal(new Set(files.map((file) => file.name)).size, files.length);
  for (const required of ["sherpa-onnx.node", "onnxruntime.dll", "sherpa-onnx-c-api.dll"])
    assert.ok(files.some((file) => file.name === required));
  for (const file of files) {
    assert.match(file.name, /^[a-zA-Z0-9_.-]+\.(node|dll)$/);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
  assert.equal(
    identity.installer.filename,
    installerName(recipe),
    "Portable installer filename required",
  );
  const installer = join(directory, installerName(recipe));
  assert.equal(lstatSync(installer).size, identity.installer.bytes);
  assert.equal(hash(installer), identity.installer.sha256, "Corrupt cached installer");
  return { identity, receipt, bytes };
}

export function consumeCache(directory, recipe, root) {
  const validated = validateCache(directory, recipe);
  const output = join(root, "packages", "previous");
  mkdirSync(output, { recursive: true });
  assert.deepEqual(readdirSync(output), [], "Empty predecessor destination required");
  const filename = join(output, installerName(recipe));
  copyFileSync(join(directory, installerName(recipe)), filename);
  assert.equal(hash(filename), validated.identity.installer.sha256);
  const identity = {
    ...validated.identity,
    installer: { ...validated.identity.installer, filename },
  };
  save(join(root, "previous.json"), identity);
  save(join(root, "evidence", "previous-packaging.json"), identity);
  save(join(root, "evidence", "predecessor-cache.json"), {
    hit: true,
    key: cacheKey(recipe),
    ...validated,
  });
  return identity;
}

const tarBinary = () =>
  process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";

// The archive holds exactly the three staged files and nothing else.
export function checkInventory(names, verbose, recipe) {
  checkArchiveListing(names, verbose, inventory(recipe));
  assert.deepEqual([...names].sort(), inventory(recipe), "Exact predecessor archive inventory");
}

function checkArchive(archive, recipe, tar) {
  const list = (flags) =>
    execFileSync(tar, [flags, archive], { encoding: "utf8", timeout: 60_000 })
      .split(/\r?\n/)
      .filter(Boolean);
  checkInventory(
    list("-tf").map((name) => name.replace(/\/$/, "")),
    list("-tvf"),
    recipe,
  );
}

export function writeArchive(directory, archive, recipe, tar = tarBinary()) {
  validateCache(directory, recipe);
  assert.equal(existsSync(archive), false);
  execFileSync(tar, ["-cf", archive, "-C", directory, ...inventory(recipe)], { timeout: 300_000 });
  checkArchive(archive, recipe, tar);
  const bytes = statSync(archive).size;
  assert.ok(bytes <= cacheLimit, "Predecessor archive exceeds 200 MiB");
  return bytes;
}

// Any failure is a miss: remove what this attempt created so the rebuild runs clean.
export async function restoreArchive(
  { archive, directory, root },
  loadRecipe,
  { verify = verifyBuildCache, tar = tarBinary() } = {},
) {
  const consumed = [
    join(root, "packages", "previous"),
    join(root, "previous.json"),
    join(root, "evidence", "previous-packaging.json"),
    join(root, "evidence", "predecessor-cache.json"),
  ];
  const existing = new Set([...consumed, directory].filter((path) => existsSync(path)));
  try {
    const recipe = loadRecipe();
    assert.ok(statSync(archive).size <= cacheLimit, "Predecessor archive exceeds 200 MiB");
    const archiveSha256 = await verify(archive, { key: cacheKey(recipe), writer });
    checkArchive(archive, recipe, tar);
    assert.equal(existsSync(directory), false, "Refuse existing predecessor cache directory");
    mkdirSync(directory, { recursive: true });
    execFileSync(tar, ["-xf", archive, "-C", directory], { timeout: 300_000 });
    return { verified: true, archiveSha256, identity: consumeCache(directory, recipe, root) };
  } catch (error) {
    for (const path of [directory, ...consumed])
      if (!existing.has(path)) rmSync(path, { recursive: true, force: true });
    return { verified: false, error };
  } finally {
    rmSync(archive, { force: true });
  }
}

function recipeForRunner() {
  assert.equal(process.platform, "win32");
  assert.equal(process.version, "v26.11.0");
  assert.ok(["arm64", "x64"].includes(process.arch));
  assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
  assert.ok(process.env.ImageOS && process.env.ImageVersion);
  const npmEntry = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  assert.equal(
    execFileSync(process.execPath, [npmEntry, "--version"], {
      encoding: "utf8",
      timeout: 15000,
    }).trim(),
    "11.20.0",
  );
  const lock = execFileSync("git", ["show", `${previousSha}:package-lock.json`], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
  });
  const packages = JSON.parse(lock).packages;
  assert.equal(packages["node_modules/electron"].version, "44.6.0");
  assert.equal(packages["node_modules/electron-builder"].version, "26.15.3");
  const { previous: previousSource } = loadWindowsSources();
  assert.equal(
    execFileSync("git", ["-C", previousSource, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 15000,
    }).trim(),
    previousSha,
  );
  const producers = [
    ".github/scripts/windows-product-build.mjs",
    ".github/scripts/windows-product-stage.ps1",
    ".github/scripts/windows-product-storage.ps1",
    ".github/scripts/windows-product-sources.mjs",
    ".github/scripts/windows-predecessor-cache.mjs",
    ".github/scripts/windows-native-toolchain.ps1",
    ".github/scripts/windows-owned-job.ps1",
    ".github/scripts/windows-owned-job.cs",
    ".github/scripts/windows-product-runtime.mjs",
    ".github/scripts/windows-product-runtime.ps1",
    ".github/scripts/windows-speech-observe.cjs",
    "packages/desktop/e2e/packaged-app-smoke.js",
    ".github/scripts/windows-job-identity.mjs",
    ".github/scripts/windows-path.mjs",
    ".github/workflows/windows-product-runtime.yml",
    ".github/scripts/windows-speech-binding.mjs",
    ".github/scripts/windows-pe.mjs",
    ".github/scripts/windows-electron-binding/CMakeLists.txt",
  ];
  return predecessorRecipe({
    lock: lockIdentity(lock, join(previousSource, "package-lock.json")),
    architecture: process.arch,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    bindingProvenance: process.arch === "arm64" ? bindingProvenance() : null,
    producers: Object.fromEntries(producers.map((name) => [name, hash(name)])),
    compiler: process.env.PASEO_NATIVE_COMPILER,
  });
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(process.env.GITHUB_REF, "refs/heads/dev");
  assertNativeActor(process.env);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const [operation] = process.argv.slice(2);
  const root = join(
    process.env.RUNNER_TEMP,
    `paseo-windows-products-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  );
  const directory = join(process.env.RUNNER_TEMP, "paseo-windows-predecessor-cache");
  const archive = join(process.env.RUNNER_TEMP, "paseo-windows-predecessor.tar");
  const recipeFile = join(process.env.RUNNER_TEMP, "paseo-windows-predecessor-recipe.json");
  const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  if (operation === "prepare") {
    const { key: recipe, diagnostics } = recipeForRunner();
    const candidate = json(join(root, "candidate.json"));
    assert.equal(candidate.sourceSha, process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA);
    if (process.arch === "arm64")
      assert.deepEqual(candidate.binding.provenance, recipe.bindingProvenance);
    save(recipeFile, { key: recipe, diagnostics });
    output("key", cacheKey(recipe));
    output("archive", archive);
    console.log(JSON.stringify({ key: cacheKey(recipe), diagnostics }));
    return;
  }
  const loadRecipe = () => {
    const saved = json(recipeFile);
    assert.deepEqual(saved.key, recipeForRunner().key);
    return saved;
  };
  if (operation === "verify") {
    const result = await restoreArchive({ archive, directory, root }, () => {
      const { key: recipe } = loadRecipe();
      assert.equal(
        process.env.PREDECESSOR_CACHE_MATCHED_KEY,
        cacheKey(recipe),
        "Exact cache match required",
      );
      return recipe;
    });
    output("verified", String(result.verified));
    if (result.verified)
      console.log(
        JSON.stringify({
          restored: result.identity.installer,
          sourceSha: result.identity.sourceSha,
          archiveSha256: result.archiveSha256,
        }),
      );
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
  } else if (operation === "stage") {
    assert.deepEqual(json(join(root, "evidence/runtime-cleanup.json")), {
      installed: false,
      stateRemoved: true,
      complete: true,
    });
    assert.equal(json(join(root, "evidence/producer-cleanup.json")).complete, true);
    const identity = json(join(root, "previous.json"));
    assert.equal(
      identity.installer.filename,
      join(root, "packages", "previous", installerName(recipe)),
    );
    if (identity.installer.bytes + 1024 * 1024 > cacheLimit) {
      console.log(
        "Predecessor exceeds cache reservation; retaining uncached product verification.",
      );
      output("staged", "false");
      return;
    }
    mkdirSync(directory, { recursive: true });
    assert.deepEqual(readdirSync(directory), [], "Refuse unexpected cache staging content");
    copyFileSync(identity.installer.filename, join(directory, installerName(recipe)));
    save(join(directory, "previous.json"), {
      ...identity,
      installer: { ...identity.installer, filename: installerName(recipe) },
    });
    save(join(directory, "receipt.json"), {
      key: recipe,
      diagnostics,
      producerSha: process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      identitySha256: hash(join(directory, "previous.json")),
    });
    const validated = validateCache(directory, recipe);
    save(join(root, "evidence/predecessor-cache.json"), {
      hit: false,
      key: cacheKey(recipe),
      ...validated,
    });
    output("staged", "true");
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
    const bytes = writeArchive(directory, archive, recipe);
    console.log(`Archived the verified predecessor (${bytes} bytes)`);
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
      output("save", "false");
      console.log("Cache usage unavailable; no cache save.");
      return;
    }
    const allowed = bytes <= cacheLimit && usage + cacheLimit <= repositorySaveCeiling;
    output("save", String(allowed));
    console.log(
      JSON.stringify({
        usage,
        bytes,
        reserve: cacheLimit,
        save: allowed,
        advisory: "Concurrent writers may race; repository hard limit still applies.",
      }),
    );
  } else throw new Error(`Unknown cache operation: ${operation}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
