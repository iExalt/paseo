import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPin,
  choosePinAsset,
  normalizedLock,
  parsePin,
  planRestore,
} from "./android-cache-pin.mjs";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const d = "d".repeat(64);
const e = "e".repeat(64);
const pin = () =>
  buildPin({
    version: "0.2.2",
    buildSha256: a,
    depsInputs: b,
    depsSha256: c,
    modulesInputs: d,
    modulesSha256: e,
  });

test("a pin's keys must name its digests and inputs", () => {
  assert.equal(pin().deps.key, `paseo-gradle-deps-v2-${b}-${c}`);
  assert.equal(pin().modules.key, `paseo-node-modules-v1-${d}-${e}`);
  // 0.2.1 published schema 1, without node_modules; the next release reads it.
  const { modules: _modules, ...v1 } = pin();
  assert.equal(parsePin(JSON.stringify({ ...v1, schemaVersion: 1 })).schemaVersion, 1);
  const text = (change) => {
    const value = pin();
    change(value);
    return JSON.stringify(value);
  };
  for (const [label, change] of [
    ["build key digest", (value) => (value.build.key = `paseo-android-build-v2-${c}`)],
    ["build key prefix", (value) => (value.build.key = `paseo-android-release-v1-${a}`)],
    ["deps key inputs", (value) => (value.deps.inputs = a)],
    ["deps key digest", (value) => (value.deps.sha256 = a)],
    ["modules key inputs", (value) => (value.modules.inputs = a)],
    ["modules missing from schema 2", (value) => delete value.modules],
    ["modules in schema 1", (value) => (value.schemaVersion = 1)],
    ["extra field", (value) => (value.build.restoreKeys = "paseo-")],
    ["schema", (value) => (value.schemaVersion = 3)],
  ]) {
    assert.throws(() => parsePin(text(change)), undefined, label);
  }
});

test("only the release's own pin asset is read", () => {
  const asset = (name) => ({ name, url: `https://api.github.com/assets/${name}` });
  const release = (tag, ...names) => ({ tag_name: tag, assets: names.map(asset) });
  assert.equal(
    choosePinAsset(release("paseo-v0.2.1", "paseo-0.2.1-android-cache-pin.json")).asset.name,
    "paseo-0.2.1-android-cache-pin.json",
  );
  for (const bad of [
    release("paseo-v0.2.1", "paseo-0.2.0-android-cache-pin.json"),
    release("paseo-v0.2.1", "paseo-0.2.1-android-cache-pin.json", "x-android-cache-pin.json"),
    release("paseo-v0.2.0", "paseo-0.2.0-android-arm64.apk"),
    release("paseo-dryrun-1", "paseo-0.2.1-android-cache-pin.json"),
  ]) {
    assert.throws(() => choosePinAsset(bad), undefined, JSON.stringify(bad));
  }
});

test("Gradle caches restore regardless of inputs; node_modules only for identical inputs", () => {
  assert.deepEqual(planRestore(null, { deps: b, modules: d }), {
    build: null,
    deps: null,
    depsInputsMatch: false,
    modules: null,
  });
  assert.deepEqual(planRestore(pin(), { deps: b, modules: d }), {
    build: { key: `paseo-android-build-v2-${a}`, sha256: a },
    deps: { key: `paseo-gradle-deps-v2-${b}-${c}`, sha256: c },
    depsInputsMatch: true,
    modules: { key: `paseo-node-modules-v1-${d}-${e}`, sha256: e },
  });
  const changed = planRestore(pin(), { deps: a, modules: a });
  assert.equal(changed.deps.key, `paseo-gradle-deps-v2-${b}-${c}`);
  assert.equal(changed.depsInputsMatch, false);
  assert.equal(changed.modules, null);
});

test("a release's own version bump leaves the normalized lockfile unchanged", () => {
  const lock = (version, change = () => {}) => {
    const value = {
      name: "paseo",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "paseo", version, workspaces: ["packages/client"] },
        "packages/client": {
          name: "@getpaseo/client",
          version,
          dependencies: { "@getpaseo/protocol": version, ws: "^8.0.0" },
        },
        "packages/protocol": { name: "@getpaseo/protocol", version },
        "node_modules/@getpaseo/client": { resolved: "packages/client", link: true },
        "node_modules/@getpaseo/protocol": { resolved: "packages/protocol", link: true },
        "node_modules/ws": { version: "8.18.0", integrity: "sha512-x" },
      },
    };
    change(value);
    return normalizedLock(value);
  };
  assert.equal(lock("0.2.1"), lock("0.2.2"));
  for (const [label, change] of [
    ["registry version", (value) => (value.packages["node_modules/ws"].version = "8.18.1")],
    ["integrity", (value) => (value.packages["node_modules/ws"].integrity = "sha512-y")],
    ["external spec", (value) => (value.packages["packages/client"].dependencies.ws = "^9.0.0")],
    [
      "new workspace link",
      (value) =>
        (value.packages["node_modules/@getpaseo/relay"] = {
          resolved: "packages/relay",
          link: true,
        }),
    ],
  ]) {
    assert.notEqual(lock("0.2.1", change), lock("0.2.1"), label);
  }
});

test("verify keeps a matching tar and deletes one restored with other content", () => {
  const dir = mkdtempSync(join(tmpdir(), "android-cache-pin-"));
  try {
    const script = fileURLToPath(new URL("./android-cache-pin.mjs", import.meta.url));
    const tar = join(dir, "build.tar");
    const verify = (sha256) => {
      const githubOutput = join(dir, "output");
      writeFileSync(githubOutput, "");
      const stdout = execFileSync(process.execPath, [script, "verify", tar, sha256], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      });
      return { stdout, output: readFileSync(githubOutput, "utf8") };
    };
    writeFileSync(tar, "pinned bytes");
    const actual = createHash("sha256").update("pinned bytes").digest("hex");
    assert.equal(verify(actual).output, "ok=true\n");
    assert.ok(existsSync(tar));
    // A squatter can create the pinned key first, but not with the pinned bytes.
    const squatted = verify("d".repeat(64));
    assert.equal(squatted.output, "ok=false\n");
    assert.match(squatted.stdout, /::warning::.*building that cache cold/);
    assert.ok(!existsSync(tar));
    // A cache miss leaves no tar; that is a cold build too.
    assert.equal(verify(actual).output, "ok=false\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
