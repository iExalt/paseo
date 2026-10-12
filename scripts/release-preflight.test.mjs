import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { releasePreflight } from "../.github/scripts/release-please-preflight.mjs";

test("clean target preflight bounds bootstrap, pauses merged proposals and rejects nonancestor history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-release-preflight-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8" },
    ).trim();
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const write = async (file, content) => {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "test: release fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet");
    const root = JSON.parse(await read("package.json"));
    for (const file of [
      "package.json",
      "package-lock.json",
      ".github/fork-release.json",
      "CHANGELOG.fork.md",
      ...root.workspaces.map((workspace) => `${workspace}/package.json`),
    ])
      await write(file, await read(file));
    // Bootstrap is a historical fixture even after the real source advances.
    const packages = await Promise.all(
      ["", ...root.workspaces].map(async (workspace) => [
        workspace,
        JSON.parse(await read(workspace ? `${workspace}/package.json` : "package.json")),
      ]),
    );
    const names = new Set(packages.map(([, pkg]) => pkg.name));
    const normalize = (pkg) => {
      pkg.version = "0.1.0";
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ])
        for (const name of Object.keys(pkg[field] ?? {}))
          if (names.has(name) && pkg[field][name] !== "*") pkg[field][name] = "0.1.0";
    };
    for (const [workspace, pkg] of packages) {
      normalize(pkg);
      await write(workspace ? `${workspace}/package.json` : "package.json", JSON.stringify(pkg));
    }
    const lock = JSON.parse(await read("package-lock.json"));
    lock.version = "0.1.0";
    for (const [workspace] of packages) normalize(lock.packages[workspace]);
    await write("package-lock.json", JSON.stringify(lock));
    const fork = JSON.parse(await read(".github/fork-release.json"));
    fork.version = "0.1.0";
    await write(".github/fork-release.json", JSON.stringify(fork));
    const sourceSha = commit();
    const config = JSON.parse(await read("release-please-config.json"));
    config["bootstrap-sha"] = sourceSha;
    config["last-release-sha"] = sourceSha;
    config.packages["."]["release-as"] = "0.1.0";
    await write("release-please-config.json", JSON.stringify(config));
    const boundary = {
      schemaVersion: 1,
      kind: "bootstrap",
      version: "0.0.0",
      originalSha: sourceSha,
      currentSha: sourceSha,
    };
    await write(".github/release-boundary.json", JSON.stringify(boundary));
    await write(".release-please-manifest.json", JSON.stringify({ ".": "0.0.0" }));
    let expectedSha = commit();
    const check = () =>
      releasePreflight({
        repositoryPath: directory,
        branch: "dev",
        expectedSha,
        request: async () => {
          throw new Error("Bootstrap must not request release API");
        },
      });
    assert.equal((await check()).ready, true);
    await write(".release-please-manifest.json", JSON.stringify({ ".": "0.1.0" }));
    expectedSha = commit();
    assert.equal((await check()).ready, false);
    const releaseSha = expectedSha;
    Object.assign(boundary, {
      kind: "release",
      version: "0.1.0",
      originalSha: releaseSha,
      currentSha: releaseSha,
    });
    config["last-release-sha"] = releaseSha;
    delete config.packages["."]["release-as"];
    await write(".github/release-boundary.json", JSON.stringify(boundary));
    await write("release-please-config.json", JSON.stringify(config));
    expectedSha = commit();
    git("tag", "v0.1.0", releaseSha);
    const release = { draft: false, prerelease: false, tag_name: "v0.1.0" };
    const published = () =>
      releasePreflight({
        repositoryPath: directory,
        branch: "dev",
        expectedSha,
        request: async (url) => {
          assert.equal(url, "/repos/iExalt/paseo/releases/tags/v0.1.0");
          return release;
        },
      });
    assert.equal((await published()).ready, true);
    release.draft = true;
    await assert.rejects(published());
    release.draft = false;
    git("tag", "--force", "v0.1.0", sourceSha);
    await assert.rejects(published(), /Published tag/);
    boundary.currentSha = "f".repeat(40);
    config["bootstrap-sha"] = boundary.currentSha;
    config["last-release-sha"] = boundary.currentSha;
    await write(".github/release-boundary.json", JSON.stringify(boundary));
    await write("release-please-config.json", JSON.stringify(config));
    expectedSha = commit();
    await assert.rejects(check(), /not an ancestor/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
