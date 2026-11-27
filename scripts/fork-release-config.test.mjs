import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  inspectForkRelease,
  assertForkReleasePreserved,
  FORK_CONFIG_PATH,
} from "./fork-release-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(`${root}${file}`, "utf8");

test("authoritative fork metadata matches every workspace, internal dependency and lock entry", async () => {
  const before = await inspectForkRelease(read);
  for (const file of [
    FORK_CONFIG_PATH,
    "package.json",
    "packages/client/package.json",
    "package-lock.json",
  ]) {
    const value = JSON.parse(await read(file));
    value.version = `${before.config.version}-mismatch`;
    await assert.rejects(
      inspectForkRelease((name) => (name === file ? JSON.stringify(value) : read(name))),
    );
  }
  const brokenLock = JSON.parse(await read("package-lock.json"));
  brokenLock.packages["node_modules/@getpaseo/client"].resolved = "packages/server";
  await assert.rejects(
    inspectForkRelease((name) =>
      name === "package-lock.json" ? JSON.stringify(brokenLock) : read(name),
    ),
  );
  const after = structuredClone(before);
  after.config.upstreamBase = "a".repeat(40);
  assertForkReleasePreserved(before, after, after.config.upstreamBase);
  assert.throws(() => assertForkReleasePreserved(before, after));
  after.changelog += "upstream replacement";
  assert.throws(() => assertForkReleasePreserved(before, after, after.config.upstreamBase));
});

test("only the pinned Markdown migration can add its private lockstep workspace", async () => {
  const upstream = "518e58cd639f01f63da35544bce3eff5123b10ee";
  const directory = "packages/react-native-enriched-markdown";
  const name = "react-native-enriched-markdown";
  const config = JSON.parse(await read(FORK_CONFIG_PATH));
  config.upstreamBase = "0273b6b614bac623168d03e7f89f9e161274b468";
  const rootManifest = { name: "paseo", version: config.version, workspaces: [] };
  const lock = { version: config.version, packages: { "": rootManifest } };
  const manifest = { name, version: config.version, private: true };
  const files = new Map([
    [FORK_CONFIG_PATH, config],
    ["package.json", rootManifest],
    ["package-lock.json", lock],
    [`${directory}/package.json`, manifest],
  ]);
  const readFixture = (path) => (files.has(path) ? JSON.stringify(files.get(path)) : read(path));
  const before = await inspectForkRelease(readFixture);
  rootManifest.workspaces.push(directory);
  lock.packages[directory] = { name, version: manifest.version };
  lock.packages[`node_modules/${name}`] = { resolved: directory, link: true };
  const after = await inspectForkRelease(readFixture);

  assert.throws(() => assertForkReleasePreserved(before, after), /workspace membership/);
  const migration = { migrationTarget: upstream };
  assertForkReleasePreserved(before, after, before.config.upstreamBase, migration);
  const promoted = { ...after, config: { ...after.config, upstreamBase: upstream } };
  assertForkReleasePreserved(before, promoted, upstream);
  assertForkReleasePreserved(promoted, promoted);
  assert.throws(
    () => assertForkReleasePreserved(after, before, before.config.upstreamBase, migration),
    /workspace membership/,
  );
  const otherConfig = { ...before.config, upstreamBase: "a".repeat(40) };
  assert.throws(
    () =>
      assertForkReleasePreserved(
        { ...before, config: otherConfig },
        { ...after, config: otherConfig },
        otherConfig.upstreamBase,
        migration,
      ),
    /workspace membership/,
  );
  const extra = { ...after, workspaces: [...after.workspaces, "packages/extra"] };
  assert.throws(
    () => assertForkReleasePreserved(before, extra, before.config.upstreamBase, migration),
    /workspace membership/,
  );

  manifest.private = false;
  await assert.rejects(
    inspectForkRelease(readFixture),
    /Vendored Markdown workspace must stay private/,
  );
  manifest.private = true;
  manifest.name = "different-markdown";
  await assert.rejects(inspectForkRelease(readFixture));
  manifest.name = name;
  manifest.version = "0.18.0";
  await assert.rejects(inspectForkRelease(readFixture), /version differs from fork version/);
});
