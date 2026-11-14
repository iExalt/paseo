import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { forkAndroidVersionCode } from "./fork-version.mjs";

export const FORK_CONFIG_PATH = ".github/fork-release.json";
export const FORK_CHANGELOG_PATH = "CHANGELOG.fork.md";
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export function validateForkConfig(config) {
  assert.deepEqual(Object.keys(config).sort(), [
    "lineage",
    "repository",
    "schemaVersion",
    "upstreamBase",
    "version",
  ]);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.repository, "iExalt/paseo");
  assert.equal(config.lineage, "iExalt/paseo:semver-v1");
  forkAndroidVersionCode(config.version);
  assert.match(config.upstreamBase, /^[a-f0-9]{40}$/);
  return config;
}

// A caller may read immutable Git blobs instead of the working tree during rebase.
export async function inspectForkRelease(read) {
  const config = validateForkConfig(JSON.parse(await read(FORK_CONFIG_PATH)));
  const root = JSON.parse(await read("package.json"));
  assert.ok(Array.isArray(root.workspaces), "Explicit workspace paths are required");
  assert.equal(new Set(root.workspaces).size, root.workspaces.length);
  const entries = [["", root]];
  for (const directory of root.workspaces) {
    assert.match(directory, /^(?:packages\/[a-z0-9-]+|plugins)$/);
    entries.push([directory, JSON.parse(await read(`${directory}/package.json`))]);
  }
  const names = new Set(entries.map(([, pkg]) => pkg.name));
  assert.equal(names.size, entries.length, "Workspace names must be unique");
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(lock.version, config.version, "Root lock version differs from fork version");
  assert.deepEqual(lock.packages[""].workspaces, root.workspaces);
  for (const [directory, pkg] of entries) {
    assert.equal(
      pkg.version,
      config.version,
      `${directory || "root"} version differs from fork version`,
    );
    const locked = lock.packages[directory];
    assert.equal(locked?.version, config.version, `${directory || "root"} lock version differs`);
    // npm omits workspace names in some lock entries; links still bind their identity.
    if (locked.name !== undefined) assert.equal(locked.name, pkg.name);
    if (directory) {
      assert.equal(lock.packages[`node_modules/${pkg.name}`]?.link, true);
      assert.equal(lock.packages[`node_modules/${pkg.name}`]?.resolved, directory);
    }
    for (const section of sections) {
      assert.deepEqual(locked[section], pkg[section], `${directory} locked ${section} differs`);
      for (const [name, range] of Object.entries(pkg[section] ?? {})) {
        if (names.has(name))
          assert.equal(
            range,
            pkg.private ? "*" : config.version,
            `${directory} internal dependency ${name} differs`,
          );
      }
    }
  }
  const changelog = await read(FORK_CHANGELOG_PATH);
  assert.ok(changelog.trim(), "Fork changelog is required");
  return { config, changelog, workspaces: root.workspaces };
}

export function assertForkReleasePreserved(
  before,
  after,
  upstreamBase = before.config.upstreamBase,
) {
  assert.deepEqual(
    after.config,
    { ...before.config, upstreamBase },
    "Rebase changed authoritative fork release metadata",
  );
  assert.deepEqual(
    after.workspaces,
    before.workspaces,
    "Rebase changed release workspace membership",
  );
  assert.equal(after.changelog, before.changelog, "Rebase changed fork changelog history");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const state = await inspectForkRelease((file) => readFile(resolve(file), "utf8"));
  console.log(
    `Fork ${state.config.version}: workspace, lock and Android encoding contracts passed`,
  );
}
