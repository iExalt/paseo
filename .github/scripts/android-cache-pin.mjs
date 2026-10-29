// Release-pinned Android caches for release.yml. Any job on dev can save cache
// entries, so a release build restores only the exact keys the latest
// published release pinned, and only after the tar matches the pinned sha256.
// Every problem means a cold build, never a failure.
//   plan                          hash this checkout's cache inputs and read the latest release's
//                                 pin; write both to GITHUB_OUTPUT (needs ImageOS and NPM_VERSION)
//   verify <tar> <sha256>         write ok=true|false; delete a tar that does not match
//   pin <out> <version>           write the pin JSON from BUILD_SHA256, DEPS_INPUTS, DEPS_SHA256,
//                                 MODULES_INPUTS and MODULES_SHA256
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEX = /^[0-9a-f]{64}$/;
const BUILD_KEY = /^paseo-android-build-v2-([0-9a-f]{64})$/;
const DEPS_KEY = /^paseo-gradle-deps-v2-([0-9a-f]{64})-([0-9a-f]{64})$/;
const MODULES_KEY = /^paseo-node-modules-v1-([0-9a-f]{64})-([0-9a-f]{64})$/;
const RELEASE_TAG = /^paseo-v(\d+\.\d+\.\d+)$/;

export const pinAssetName = (version) => `paseo-${version}-android-cache-pin.json`;
export const buildKey = (sha256) => `paseo-android-build-v2-${sha256}`;
export const depsKey = (inputs, sha256) => `paseo-gradle-deps-v2-${inputs}-${sha256}`;
export const modulesKey = (inputs, sha256) => `paseo-node-modules-v1-${inputs}-${sha256}`;

export function buildPin({
  version,
  buildSha256,
  depsInputs,
  depsSha256,
  modulesInputs,
  modulesSha256,
}) {
  const pin = {
    schemaVersion: 2,
    version,
    build: { key: buildKey(buildSha256), sha256: buildSha256 },
    deps: { key: depsKey(depsInputs, depsSha256), sha256: depsSha256, inputs: depsInputs },
    modules: {
      key: modulesKey(modulesInputs, modulesSha256),
      sha256: modulesSha256,
      inputs: modulesInputs,
    },
  };
  return parsePin(JSON.stringify(pin));
}

// Throws unless the pin is exactly the expected shape and each key names its
// digest. Schema 1 (0.2.1) has no node_modules entry.
export function parsePin(text) {
  const pin = JSON.parse(text);
  const fields = (value, names) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
  const entries = { 1: ["build", "deps"], 2: ["build", "deps", "modules"] }[pin?.schemaVersion];
  if (!entries || !fields(pin, ["schemaVersion", "version", ...entries])) {
    throw new Error("Unexpected cache pin shape");
  }
  if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error("Unexpected cache pin version");
  }
  const keyed = [
    ["deps", DEPS_KEY],
    ["modules", MODULES_KEY],
  ].filter(([name]) => entries.includes(name));
  if (
    !fields(pin.build, ["key", "sha256"]) ||
    keyed.some(([name]) => !fields(pin[name], ["key", "sha256", "inputs"]))
  ) {
    throw new Error("Unexpected cache pin entry shape");
  }
  const digests = [
    pin.build.sha256,
    ...keyed.flatMap(([name]) => [pin[name].sha256, pin[name].inputs]),
  ];
  for (const value of digests) {
    if (typeof value !== "string" || !HEX.test(value)) throw new Error("Unexpected cache digest");
  }
  if (BUILD_KEY.exec(pin.build.key)?.[1] !== pin.build.sha256) {
    throw new Error("Build cache key does not name its digest");
  }
  for (const [name, pattern] of keyed) {
    const key = pattern.exec(pin[name].key);
    if (key?.[1] !== pin[name].inputs || key?.[2] !== pin[name].sha256) {
      throw new Error(`The ${name} cache key does not name its inputs and digest`);
    }
  }
  return pin;
}

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

// Picks the one pin asset a published release carries for its own version.
export function choosePinAsset(release) {
  const version = RELEASE_TAG.exec(release?.tag_name ?? "")?.[1];
  if (!version) throw new Error(`Latest release tag ${release?.tag_name} is not a fork release`);
  const pinAssets = (release.assets ?? []).filter((asset) =>
    asset.name.endsWith("-android-cache-pin.json"),
  );
  if (pinAssets.length !== 1 || pinAssets[0].name !== pinAssetName(version)) {
    throw new Error(`Expected exactly ${pinAssetName(version)} on ${release.tag_name}`);
  }
  return { version, asset: pinAssets[0] };
}

// The pinned dependency cache is restored even when inputs changed: Gradle's
// module cache is additive, so a stale one only means extra downloads. Inputs
// decide whether the run may re-pin that entry instead of saving a new one.
// node_modules replaces npm ci, so it is restored only for identical inputs.
export function planRestore(pin, { deps, modules }) {
  if (!pin) return { build: null, deps: null, depsInputsMatch: false, modules: null };
  return {
    build: { key: pin.build.key, sha256: pin.build.sha256 },
    deps: { key: pin.deps.key, sha256: pin.deps.sha256 },
    depsInputsMatch: pin.deps.inputs === deps,
    modules:
      pin.modules?.inputs === modules ? { key: pin.modules.key, sha256: pin.modules.sha256 } : null,
  };
}

const digest = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
};

// deps: the Gradle wrapper and every Gradle plugin and library come from
// node_modules, so the lockfile decides them. modules: also what changes the
// installed tree without changing the lock, and the ABI native addons build for.
export async function cacheInputs(root = ".", env = process.env) {
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

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Returns whether the tar matches; removes it otherwise so nothing unpacks it.
export async function verifyTar(file, sha256) {
  let actual;
  try {
    actual = await sha256File(file);
  } catch {
    return { ok: false, reason: `${file} was not restored` };
  }
  if (actual === sha256) return { ok: true };
  await rm(file, { force: true });
  return { ok: false, reason: `${file} has sha256 ${actual}, pinned ${sha256}` };
}

async function output(values) {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
  process.stdout.write(lines.join(""));
}

const warn = (message) => console.log(`::warning::${message}; building that cache cold.`);

async function fetchLatestPin() {
  const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const latest = await fetch(`${api}/releases/latest`, { headers });
  if (!latest.ok) throw new Error(`releases/latest returned HTTP ${latest.status}`);
  const { asset } = choosePinAsset(await latest.json());
  const download = await fetch(asset.url, {
    headers: { ...headers, Accept: "application/octet-stream" },
  });
  if (!download.ok) throw new Error(`${asset.name} returned HTTP ${download.status}`);
  return parsePin(await download.text());
}

async function planCommand() {
  if (!process.env.ImageOS || !process.env.NPM_VERSION) {
    throw new Error("plan needs ImageOS and NPM_VERSION");
  }
  const { deps, modules } = await cacheInputs();
  let pin = null;
  try {
    pin = await fetchLatestPin();
  } catch (error) {
    warn(`No usable Android cache pin (${error.message})`);
  }
  const restore = planRestore(pin, { deps, modules });
  if (pin && !restore.modules) {
    console.log(
      "::notice::" +
        (pin.modules
          ? "The pinned node_modules inputs differ (lockfile, platform, or install files)"
          : `The ${pin.version} pin has no node_modules entry`) +
        "; building that cache cold.",
    );
  }
  await output({
    deps_inputs: deps,
    modules_inputs: modules,
    build_key: restore.build?.key ?? "",
    build_sha256: restore.build?.sha256 ?? "",
    deps_key: restore.deps?.key ?? "",
    deps_sha256: restore.deps?.sha256 ?? "",
    deps_inputs_match: restore.depsInputsMatch,
    modules_key: restore.modules?.key ?? "",
    modules_sha256: restore.modules?.sha256 ?? "",
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    await planCommand();
  } else if (command === "verify") {
    const [file, sha256] = args;
    const result = await verifyTar(file, sha256);
    if (!result.ok) warn(result.reason);
    await output({ ok: result.ok });
  } else if (command === "pin") {
    const [out, version] = args;
    const pin = buildPin({
      version,
      buildSha256: process.env.BUILD_SHA256,
      depsInputs: process.env.DEPS_INPUTS,
      depsSha256: process.env.DEPS_SHA256,
      modulesInputs: process.env.MODULES_INPUTS,
      modulesSha256: process.env.MODULES_SHA256,
    });
    await writeFile(out, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`Pinned ${pin.build.key}, ${pin.deps.key} and ${pin.modules.key}`);
  } else {
    throw new Error("Usage: android-cache-pin.mjs inputs|plan|verify|pin ...");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
