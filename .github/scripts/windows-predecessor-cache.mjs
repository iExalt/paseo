import assert from "node:assert/strict";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindingProvenance, digest } from "./windows-speech-binding.mjs";

export const previousSha = "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a";
export const cacheLimit = 200 * 1024 * 1024;
export const repositorySaveCeiling = 8_000_000_000;
const hash = (filename) => digest(readFileSync(filename));
const json = (filename) => JSON.parse(readFileSync(filename));
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value), { flag: "wx" });
const installerName = (recipe) => `previous-${recipe.architecture}.exe`;
export const cacheKey = (recipe) =>
  `paseo-windows-predecessor-v1-${recipe.architecture}-${digest(JSON.stringify(recipe))}`;

export function validateCache(directory, recipe) {
  const names = [installerName(recipe), "previous.json", "receipt.json"].sort();
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
  assert.deepEqual(receipt.recipe, recipe, "Predecessor recipe mismatch");
  assert.match(receipt.producerSha, /^[a-f0-9]{40}$/);
  assert.match(receipt.runId, /^\d+$/);
  assert.match(receipt.attempt, /^\d+$/);
  assert.equal(receipt.identitySha256, hash(join(directory, "previous.json")));
  const identity = json(join(directory, "previous.json"));
  assert.equal(identity.sourceSha, previousSha);
  assert.equal(identity.lockSha256, recipe.lockSha256);
  assert.equal(identity.version, "0.11.0");
  assert.equal(identity.architecture, recipe.architecture);
  assert.equal(identity.appId, "sh.paseo.desktop");
  assert.equal(identity.archiveFilter, "BCJ");
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
    assert.equal(identity.binding.electron, "44.6.0");
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
  const producers = [
    ".github/scripts/windows-product-build.mjs",
    ".github/scripts/windows-product-stage.ps1",
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
  return {
    schema: 1,
    sourceSha: previousSha,
    lockSha256: digest(lock),
    architecture: process.arch,
    node: "26.11.0",
    npm: "11.20.0",
    electron: "44.6.0",
    builder: "26.15.3",
    archiveFilter: "BCJ",
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    bindingProvenance: process.arch === "arm64" ? bindingProvenance() : null,
    producers: Object.fromEntries(producers.map((name) => [name, hash(name)])),
  };
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(process.env.GITHUB_REF, "refs/heads/dev");
  assert.equal(process.env.GITHUB_ACTOR, "iExalt");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const [operation] = process.argv.slice(2);
  const root = join(
    process.env.RUNNER_TEMP,
    `paseo-windows-products-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  );
  const directory = join(process.env.RUNNER_TEMP, "paseo-windows-predecessor-cache");
  const recipeFile = join(process.env.RUNNER_TEMP, "paseo-windows-predecessor-recipe.json");
  const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  if (operation === "prepare" || operation === "prepare-proof") {
    const recipe = recipeForRunner();
    if (operation === "prepare") {
      const candidate = json(join(root, "candidate.json"));
      assert.equal(candidate.sourceSha, process.env.GITHUB_SHA);
      if (process.arch === "arm64")
        assert.deepEqual(candidate.binding.provenance, recipe.bindingProvenance);
    } else {
      mkdirSync(root);
      mkdirSync(join(root, "evidence"));
    }
    save(recipeFile, recipe);
    output("key", cacheKey(recipe));
    output("directory", directory);
    return;
  }
  const recipe = json(recipeFile);
  assert.deepEqual(recipe, recipeForRunner());
  if (operation === "restore") {
    assert.equal(
      process.env.PREDECESSOR_CACHE_MATCHED_KEY,
      cacheKey(recipe),
      "Exact cache match required",
    );
    const identity = consumeCache(directory, recipe, root);
    console.log(JSON.stringify({ restored: identity.installer, sourceSha: identity.sourceSha }));
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
      output("save", "false");
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
      recipe,
      producerSha: process.env.GITHUB_SHA,
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
    const allowed = usage + cacheLimit <= repositorySaveCeiling;
    output("save", String(allowed));
    console.log(
      JSON.stringify({
        usage,
        bytes: validated.bytes,
        reserve: cacheLimit,
        save: allowed,
        advisory: "Concurrent writers may race; repository hard limit still applies.",
      }),
    );
  } else throw new Error(`Unknown cache operation: ${operation}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
