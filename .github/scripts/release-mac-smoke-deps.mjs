// Installs only the packages release-mac-smoke.mjs and the packaged-app smoke
// load, at the versions package-lock.json resolves for them, instead of the
// whole workspace. The client and server builds come from the imported
// closure's app.asar (see release-mac-smoke.mjs), so nothing is built here.
// Usage: node release-mac-smoke-deps.mjs <install directory>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWithRetry } from "../../scripts/npm-retry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// packaged-app-smoke.js requires these from packages/desktop/e2e.
export const SMOKE_PACKAGES = ["playwright", "@electron/asar", "ws"];
export const SMOKE_FROM = "packages/desktop/e2e";

// Node's lookup order from a lock path: <dir>/node_modules/<name>, then each parent.
function resolveEntry(packages, name, fromDir) {
  for (let dir = fromDir; ; dir = posix.dirname(dir)) {
    const base = dir === "." || dir === "" ? "" : `${dir}/`;
    if (!base.endsWith("node_modules/")) {
      const candidate = `${base}node_modules/${name}`;
      if (packages[candidate]) return candidate;
    }
    if (dir === "." || dir === "") return null;
  }
}

// Returns lock `packages` holding the closure of `names` resolved from
// `fromDir`, with workspace-nested entries moved to the root node_modules.
export function pruneLock(lock, names = SMOKE_PACKAGES, fromDir = SMOKE_FROM) {
  const { packages } = lock;
  const chosen = new Map();
  const visit = (name, dir, optional) => {
    const source = resolveEntry(packages, name, dir);
    if (!source) {
      if (optional) return;
      throw new Error(`package-lock.json has no entry for ${name} from ${dir}`);
    }
    const entry = packages[source];
    // Workspace packages are linked from the closure, never installed here.
    if (entry.link || chosen.has(source)) return;
    const target = source.slice(source.indexOf("node_modules/"));
    for (const [other, chosenOther] of chosen) {
      if (chosenOther.target === target) {
        throw new Error(`${source} and ${other} would both install to ${target}`);
      }
    }
    // The smoke installs these as production dependencies of its own manifest.
    const kept = { ...entry };
    for (const flag of ["dev", "devOptional", "peer"]) delete kept[flag];
    chosen.set(source, { target, entry: kept });
    for (const dep of Object.keys(entry.dependencies ?? {})) visit(dep, source, false);
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) visit(dep, source, true);
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      visit(dep, source, entry.peerDependenciesMeta?.[dep]?.optional === true);
    }
  };
  for (const name of names) visit(name, fromDir, false);
  return Object.fromEntries([...chosen.values()].map(({ target, entry }) => [target, entry]));
}

export function smokeManifest(lock, names = SMOKE_PACKAGES, fromDir = SMOKE_FROM) {
  const pruned = pruneLock(lock, names, fromDir);
  const dependencies = Object.fromEntries(
    names.map((name) => [name, pruned[`node_modules/${name}`].version]),
  );
  const manifest = { name: "paseo-release-smoke", private: true, dependencies };
  return {
    manifest,
    lock: {
      name: manifest.name,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: manifest.name, dependencies }, ...pruned },
    },
  };
}

async function main() {
  const [installDir] = process.argv.slice(2);
  assert.ok(installDir, "Usage: node release-mac-smoke-deps.mjs <install directory>");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const { manifest, lock: smokeLock } = smokeManifest(lock);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(installDir, "package-lock.json"), `${JSON.stringify(smokeLock, null, 2)}\n`);
  const status = await runWithRetry(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    run: (args) => spawnSync("npm", args, { cwd: installDir, stdio: "inherit" }).status ?? 1,
  });
  assert.equal(status, 0, "npm ci failed for the smoke dependencies");
  // A fresh checkout has no node_modules; resolution from the repo reaches this one.
  symlinkSync(join(installDir, "node_modules"), join(root, "node_modules"), "dir");
  for (const [lockPath, entry] of Object.entries(smokeLock.packages)) {
    if (lockPath) console.log(`${lockPath} ${entry.version}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
