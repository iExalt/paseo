import assert from "node:assert/strict";
import test from "node:test";
import { pruneLock } from "./release-mac-smoke-deps.mjs";

const entry = (version, extra = {}) => ({ version, dev: true, ...extra });

test("a workspace-nested entry wins over the hoisted one and moves to the root", () => {
  const packages = pruneLock(
    {
      packages: {
        "node_modules/asar": entry("3.4.1", { dependencies: { glob: "^7" } }),
        "node_modules/glob": entry("7.2.3"),
        "packages/desktop/node_modules/asar": entry("4.3.1", { dependencies: { glob: "^13" } }),
        "packages/desktop/node_modules/glob": entry("13.0.6"),
      },
    },
    ["asar"],
    "packages/desktop/e2e",
  );
  assert.deepEqual(packages, {
    "node_modules/asar": { version: "4.3.1", dependencies: { glob: "^13" } },
    "node_modules/glob": { version: "13.0.6" },
  });
});

test("transitive dependencies follow nested-first resolution", () => {
  const packages = pruneLock(
    {
      packages: {
        "node_modules/a": entry("1.0.0", {
          dependencies: { b: "1" },
          optionalDependencies: { missing: "1" },
        }),
        "node_modules/b": entry("1.0.0", { dependencies: { c: "2" } }),
        "node_modules/b/node_modules/c": entry("2.0.0"),
        "node_modules/c": entry("1.0.0"),
        "node_modules/unrelated": entry("1.0.0"),
      },
    },
    ["a"],
    "packages/desktop/e2e",
  );
  assert.deepEqual(Object.keys(packages).sort(), [
    "node_modules/a",
    "node_modules/b",
    "node_modules/b/node_modules/c",
  ]);
});

test("workspace links are left to the closure", () => {
  const packages = pruneLock(
    {
      packages: {
        "node_modules/a": entry("1.0.0", { dependencies: { "@getpaseo/client": "*" } }),
        "node_modules/@getpaseo/client": { resolved: "packages/client", link: true },
      },
    },
    ["a"],
    "packages/desktop/e2e",
  );
  assert.deepEqual(Object.keys(packages), ["node_modules/a"]);
});

test("a dependency missing from the lock fails", () => {
  assert.throws(
    () =>
      pruneLock(
        { packages: { "node_modules/a": entry("1.0.0", { dependencies: { b: "1" } }) } },
        ["a"],
        "packages/desktop/e2e",
      ),
    /no entry for b/,
  );
});
