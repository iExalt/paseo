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
