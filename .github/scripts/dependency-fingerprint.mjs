// The dependency fingerprint: digests of what decides an installed tree, minus
// the release's own version bump, so a release PR reuses dev's caches. Routine
// CI keys its installed-dependency cache on it and android-cache-pin.mjs pins
// release caches on it. Nix fetches from its own registry-only lockfile
// (nix/package.nix), which ignores version bumps the same way; Nix runs outside
// routine CI, so that filter is checked where it runs, not here.
// Runs before npm ci: import Node builtins only.
//   routine-key   print the routine installed-dependency cache key (needs ImageOS and NPM_VERSION)
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { machine } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The lockfile without the release's own version: each release commit bumps
// the root and workspace versions and the workspaces' specs for each other,
// none of which changes an installed file outside the workspace symlinks.
export function normalizedLock(lock) {
  const workspaces = Object.entries(lock.packages ?? {}).filter(
    ([path]) => !path.split("/").includes("node_modules"),
  );
  const names = new Set(
    Object.entries(lock.packages ?? {})
      .filter(([, entry]) => entry.link)
      .map(([path]) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)),
  );
  const packages = { ...lock.packages };
  for (const [path, entry] of workspaces) {
    const { version: _version, ...rest } = entry;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (!rest[field]) continue;
      rest[field] = Object.fromEntries(
        Object.entries(rest[field]).map(([name, spec]) => [name, names.has(name) ? "*" : spec]),
      );
    }
    packages[path] = rest;
  }
  const { version: _version, ...rest } = lock;
  return JSON.stringify({ ...rest, packages });
}

const digest = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
};

function requireEnv(env) {
  if (!env.ImageOS || !env.NPM_VERSION) {
    throw new Error("The dependency fingerprint needs ImageOS and NPM_VERSION");
  }
}

// deps: the Gradle wrapper and every Gradle plugin and library come from
// node_modules, so the lockfile decides them. modules: also what changes the
// installed tree without changing the lock, and the ABI native addons build for.
export async function dependencyFingerprint(root = ".", env = process.env) {
  requireEnv(env);
  const lock = normalizedLock(JSON.parse(await readFile(`${root}/package-lock.json`, "utf8")));
  const patches = (await readdir(`${root}/patches`).catch(() => []))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  const installFiles = [
    "scripts/postinstall-patches.mjs",
    "scripts/postinstall-patches-target.mjs",
    ...patches.map((name) => `patches/${name}`),
  ];
  const installed = await Promise.all(
    installFiles.map(async (file) => `${file}\n${await readFile(`${root}/${file}`, "utf8")}`),
  );
  const platform = [env.ImageOS, process.arch, process.version, env.NPM_VERSION].join(" ");
  return { deps: digest(lock), modules: digest(lock, platform, ...installed) };
}

// Weekly image versions are omitted so rollouts do not split the cache; node,
// npm, arch and ImageOS fix the ABI. If a new image breaks a cached native
// addon, bump v2 to recover. Predecessor caches keep the image version.
// machine() must equal the `uname -m` the key used before this module, or the
// cache splits silently. The superseded-cache cleanup in ci.yml lists caches
// by the routine-modules- prefix.
export function routineCacheKey({ modules }, env = process.env) {
  requireEnv(env);
  return `routine-modules-v2-${env.ImageOS}-${machine()}-node${process.version}-npm${env.NPM_VERSION}-${modules}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command] = process.argv.slice(2);
  if (command !== "routine-key") throw new Error("Usage: dependency-fingerprint.mjs routine-key");
  console.log(routineCacheKey(await dependencyFingerprint()));
}
