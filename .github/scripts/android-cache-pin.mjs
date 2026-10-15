// Release-pinned Android caches for release.yml. Any job on dev can save cache
// entries, so a release build restores only the exact keys the latest
// published release pinned, and only after the tar matches the pinned sha256.
// Every problem means a cold build, never a failure.
//   plan <inputs>                 read the latest release's pin; write restore keys to GITHUB_OUTPUT
//   verify <tar> <sha256>         write ok=true|false; delete a tar that does not match
//   pin <out> <version>           write the pin JSON from BUILD_SHA256, DEPS_INPUTS and DEPS_SHA256
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEX = /^[0-9a-f]{64}$/;
const BUILD_KEY = /^paseo-android-build-v2-([0-9a-f]{64})$/;
const DEPS_KEY = /^paseo-gradle-deps-v2-([0-9a-f]{64})-([0-9a-f]{64})$/;
const RELEASE_TAG = /^paseo-v(\d+\.\d+\.\d+)$/;

export const pinAssetName = (version) => `paseo-${version}-android-cache-pin.json`;
export const buildKey = (sha256) => `paseo-android-build-v2-${sha256}`;
export const depsKey = (inputs, sha256) => `paseo-gradle-deps-v2-${inputs}-${sha256}`;

export function buildPin({ version, buildSha256, depsInputs, depsSha256 }) {
  const pin = {
    schemaVersion: 1,
    version,
    build: { key: buildKey(buildSha256), sha256: buildSha256 },
    deps: { key: depsKey(depsInputs, depsSha256), sha256: depsSha256, inputs: depsInputs },
  };
  return parsePin(JSON.stringify(pin));
}

// Throws unless the pin is exactly the expected shape and each key names its digest.
export function parsePin(text) {
  const pin = JSON.parse(text);
  const fields = (value, names) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
  if (!fields(pin, ["schemaVersion", "version", "build", "deps"]) || pin.schemaVersion !== 1) {
    throw new Error("Unexpected cache pin shape");
  }
  if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error("Unexpected cache pin version");
  }
  if (!fields(pin.build, ["key", "sha256"]) || !fields(pin.deps, ["key", "sha256", "inputs"])) {
    throw new Error("Unexpected cache pin entry shape");
  }
  for (const value of [pin.build.sha256, pin.deps.sha256, pin.deps.inputs]) {
    if (typeof value !== "string" || !HEX.test(value)) throw new Error("Unexpected cache digest");
  }
  if (BUILD_KEY.exec(pin.build.key)?.[1] !== pin.build.sha256) {
    throw new Error("Build cache key does not name its digest");
  }
  const deps = DEPS_KEY.exec(pin.deps.key);
  if (deps?.[1] !== pin.deps.inputs || deps?.[2] !== pin.deps.sha256) {
    throw new Error("Dependency cache key does not name its inputs and digest");
  }
  return pin;
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
export function planRestore(pin, inputs) {
  if (!pin) return { build: null, deps: null, depsInputsMatch: false };
  return {
    build: { key: pin.build.key, sha256: pin.build.sha256 },
    deps: { key: pin.deps.key, sha256: pin.deps.sha256 },
    depsInputsMatch: pin.deps.inputs === inputs,
  };
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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    const [inputs] = args;
    if (!HEX.test(inputs ?? "")) throw new Error("Usage: plan <inputs sha256>");
    let pin = null;
    try {
      pin = await fetchLatestPin();
    } catch (error) {
      warn(`No usable Android cache pin (${error.message})`);
    }
    const plan = planRestore(pin, inputs);
    await output({
      build_key: plan.build?.key ?? "",
      build_sha256: plan.build?.sha256 ?? "",
      deps_key: plan.deps?.key ?? "",
      deps_sha256: plan.deps?.sha256 ?? "",
      deps_inputs_match: plan.depsInputsMatch,
    });
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
    });
    await writeFile(out, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`Pinned ${pin.build.key} and ${pin.deps.key}`);
  } else {
    throw new Error("Usage: android-cache-pin.mjs plan|verify|pin ...");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
