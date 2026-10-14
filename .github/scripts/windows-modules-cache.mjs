import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNativeActor } from "./native-candidate-authority.mjs";
import { checkArchiveListing, fileDigest, verifyBuildCache } from "./build-cache-provenance.mjs";
import { repositorySaveCeiling } from "./windows-predecessor-cache.mjs";
import { loadWindowsSources } from "./windows-product-sources.mjs";

// Installed candidate dependencies for Windows arm64, where npm ci takes 11-22
// minutes. Only a dispatched dev run writes them; candidates verify the
// attestation before extracting, then let npm reconcile the tree. The signer is
// dev-head code (its install scripts run in the writer), the same trust as the
// candidate source. Entries are immutable: replace a bad one with
// `gh cache delete <key>` and another writer dispatch.
export const writer = "windows-product-runtime.yml";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// A release only bumps workspace versions, which never reach node_modules.
export function normalizeLock(lock) {
  const copy = structuredClone(lock);
  delete copy.version;
  const workspaces = Object.entries(copy.packages).filter(
    ([path]) => !path.split("/").includes("node_modules"),
  );
  const names = new Set(workspaces.map(([, entry]) => entry.name).filter(Boolean));
  for (const [, entry] of workspaces) {
    delete entry.version;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      for (const name of Object.keys(entry[field] ?? {}))
        if (names.has(name)) delete entry[field][name];
  }
  return copy;
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

export function modulesRecipe(source, env = process.env) {
  assert.match(
    env.PASEO_NATIVE_COMPILER ?? "",
    /\\MSVC\\[0-9.]+\\bin\\Host/i,
    "Compiler path required",
  );
  const lock = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"));
  const inputs = [
    ...filesUnder(join(source, "patches")),
    ...readdirSync(join(source, "scripts"))
      .filter((name) => name.startsWith("postinstall-patches"))
      .map((name) => join(source, "scripts", name))
      .sort(),
  ];
  return {
    schema: 1,
    lock: sha256(JSON.stringify(normalizeLock(lock))),
    inputs: Object.fromEntries(
      inputs.map((file) => [
        file.slice(source.length + 1).replaceAll("\\", "/"),
        sha256(readFileSync(file)),
      ]),
    ),
    architecture: process.arch,
    node: process.version,
    npm: JSON.parse(
      readFileSync(join(dirname(process.execPath), "node_modules/npm/package.json"), "utf8"),
    ).version,
    imageOS: env.ImageOS,
    compiler: env.PASEO_NATIVE_COMPILER.replace(/^.*\\VC\\Tools\\/i, ""),
  };
}

export const modulesKey = (recipe) =>
  `paseo-windows-modules-v1-${recipe.architecture}-${sha256(JSON.stringify(recipe))}`;

// The key decides only the hit rate; correctness rests on the attestation, npm
// reconciling the tree and the unchanged-lockfile assertion after install.

// Every installed tree: the root and each workspace's own node_modules.
export function moduleRoots(source) {
  const { workspaces } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  return ["node_modules", ...workspaces.map((workspace) => `${workspace}/node_modules`)];
}

// Windows tar follows npm's workspace junctions and would archive the writer's
// workspace sources in their place; npm recreates the links after extraction.
export function workspaceLinks(lock) {
  return Object.entries(lock.packages)
    .filter(([, entry]) => entry.link)
    .map(([path]) => path)
    .sort();
}

// The cache stores the archive compressed: 3.71 GB became a 0.93 GB entry (0.25)
// in the spike, so reserve 0.4 of the archive against the save ceiling.
export const compressedReserve = (bytes) => Math.ceil(bytes * 0.4);
export const modulesSaveAllowed = (usage, bytes) =>
  usage + compressedReserve(bytes) <= repositorySaveCeiling;

const tar = () => join(process.env.SystemRoot, "System32", "tar.exe");

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(process.env.GITHUB_REF, "refs/heads/dev");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.arch, "arm64");
  assertNativeActor(process.env);
  const { candidate: source } = loadWindowsSources();
  const archive = join(process.env.RUNNER_TEMP, "paseo-windows-modules.tar");
  const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  const [operation] = process.argv.slice(2);
  if (operation === "key") {
    const key = modulesKey(modulesRecipe(source));
    output("key", key);
    output("archive", archive);
    console.log(`Installed dependency cache key ${key}`);
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
    assert.equal(existsSync(archive), false);
    const roots = moduleRoots(source).filter((root) => existsSync(join(source, root)));
    const links = workspaceLinks(JSON.parse(readFileSync(join(source, "package-lock.json"))));
    assert.ok(links.length > 0);
    execFileSync(
      tar(),
      ["-cf", archive, "-C", source, ...links.flatMap((link) => ["--exclude", link]), ...roots],
      { stdio: "inherit", timeout: 600_000 },
    );
    const list = (flags) =>
      execFileSync(tar(), [flags, archive], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 300_000,
      })
        .split(/\r?\n/)
        .filter(Boolean);
    checkArchiveListing(
      list("-tf").map((name) => name.replace(/\/$/, "")),
      list("-tvf"),
      roots,
      links,
    );
    const digest = await fileDigest(archive);
    output("digest", digest);
    output("bytes", statSync(archive).size);
    console.log(`Archived installed dependencies (${statSync(archive).size} bytes, ${digest})`);
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
      console.log("::warning::Cache usage unavailable; installed dependencies not saved.");
      return;
    }
    const allowed = modulesSaveAllowed(usage, bytes);
    output("save", String(allowed));
    console.log(JSON.stringify({ usage, bytes, reserve: compressedReserve(bytes), save: allowed }));
    if (!allowed)
      console.log(
        "::warning::Repository cache headroom is too low; installed dependencies not saved.",
      );
  } else if (operation === "self-verify") {
    // The writer proves its own attestation verifies before any candidate needs it.
    const digest = await verifyBuildCache(archive, { key: process.env.PASEO_MODULES_KEY, writer });
    console.log(`Writer attestation verifies for ${digest}`);
  } else if (operation === "verify") {
    const key = process.env.PASEO_MODULES_KEY;
    try {
      const digest = await verifyBuildCache(archive, { key, writer });
      output("digest", digest);
      console.log(`Verified installed dependency archive ${digest}`);
    } catch (error) {
      rmSync(archive, { force: true });
      output("digest", "");
      console.log(
        `::warning::Installed dependency archive failed provenance (${error.message}); installing with npm ci.`,
      );
    }
  } else throw new Error(`Unknown modules cache operation: ${operation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
