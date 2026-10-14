import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  checkArchiveListing,
  modulesSaveAllowed,
  normalizeLock,
  workspaceLinks,
} from "../.github/scripts/windows-modules-cache.mjs";

const lockAt = (revision) =>
  JSON.parse(
    execFileSync("git", ["show", `${revision}:package-lock.json`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

test("installed dependency keys survive a release version bump but not a dependency change", () => {
  // facf051f8 is the 0.1.3 release commit; it changed only workspace versions.
  const before = lockAt("facf051f8^");
  const release = lockAt("facf051f8");
  assert.notDeepEqual(before, release);
  assert.deepEqual(normalizeLock(before), normalizeLock(release));
  const changed = structuredClone(release);
  changed.packages["node_modules/electron"].version = "0.0.0";
  assert.notDeepEqual(normalizeLock(changed), normalizeLock(release));
  const dependency = structuredClone(release);
  dependency.packages["packages/cli"].dependencies.chalk = "^7.0.0";
  assert.notDeepEqual(normalizeLock(dependency), normalizeLock(release));
});

test("installed dependency archives hold only regular entries inside install roots", () => {
  const links = workspaceLinks(lockAt("facf051f8"));
  assert.ok(links.includes("node_modules/@getpaseo/app"));
  const roots = ["node_modules", "packages/app/node_modules"];
  const ok = ["node_modules", "node_modules/a/index.js", "packages/app/node_modules/b"];
  const listing = (names, type = "-") => names.map((name) => `${type}rw-r--r--  0 0 0 1 ${name}`);
  checkArchiveListing(ok, listing(ok), roots, links);
  for (const [names, verbose] of [
    [["node_modules/x"], listing(["node_modules/x"], "l")],
    [["node_modules/x"], listing(["node_modules/x"], "h")],
    [["C:/node_modules/x"], listing(["C:/node_modules/x"])],
    [["/node_modules/x"], listing(["/node_modules/x"])],
    [["node_modules/../x"], listing(["node_modules/../x"])],
    [["packages/app/src/x"], listing(["packages/app/src/x"])],
    [
      ["node_modules/@getpaseo/app/package.json"],
      listing(["node_modules/@getpaseo/app/package.json"]),
    ],
    [[], []],
  ])
    assert.throws(() => checkArchiveListing(names, verbose, roots, links));
});

test("installed dependency saves reserve their compressed size against the ceiling", () => {
  const archive = 3_708_191_744;
  // About 5.6 GB in use leaves room for the compressed entry, not the raw archive.
  assert.equal(modulesSaveAllowed(5_600_000_000, archive), true);
  assert.equal(modulesSaveAllowed(6_600_000_000, archive), false);
});
