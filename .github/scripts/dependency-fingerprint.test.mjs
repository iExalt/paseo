import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { machine } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dependencyFingerprint,
  normalizedLock,
  routineCacheKey,
} from "./dependency-fingerprint.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

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

test("the routine key names the ABI and the modules fingerprint, and needs both env inputs", async () => {
  // Weekly image versions must not split the cache.
  const env = { ImageOS: "ubuntu26", ImageVersion: "20261102.1", NPM_VERSION: "11.20.0" };
  const fingerprint = await dependencyFingerprint(root, env);
  assert.match(fingerprint.deps, /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint.modules, fingerprint.deps);
  const key = `routine-modules-v2-ubuntu26-${machine()}-node${process.version}-npm11.20.0-${fingerprint.modules}`;
  assert.equal(routineCacheKey(fingerprint, env), key);
  assert.doesNotMatch(key, /20261102/);
  // The npm version is part of the ABI, so it changes the inputs, not only the prefix.
  const npm = await dependencyFingerprint(root, { ...env, NPM_VERSION: "11.21.0" });
  assert.notEqual(npm.modules, fingerprint.modules);
  assert.equal(npm.deps, fingerprint.deps);
  for (const partial of [{ ImageOS: "ubuntu26" }, { NPM_VERSION: "11.20.0" }]) {
    await assert.rejects(dependencyFingerprint(root, partial));
    assert.throws(() => routineCacheKey(fingerprint, partial));
  }
  // ci.yml reads the whole key from stdout.
  const script = fileURLToPath(new URL("./dependency-fingerprint.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [script, "routine-key"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(stdout, `${key}\n`);
});
