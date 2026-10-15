import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { releasePreflight } from "../.github/scripts/release-please-preflight.mjs";

test("preflight proposes only when the manifest equals the latest published version", async () => {
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
    await write("release-please-config.json", await read("release-please-config.json"));
    const version = root.version;
    await write(".release-please-manifest.json", JSON.stringify({ ".": version }));
    const expectedSha = commit();
    const lastReleaseSha = "a".repeat(40);
    const check = (latest) =>
      releasePreflight({
        repositoryPath: directory,
        branch: "dev",
        expectedSha,
        token: "token",
        deriveBoundary: async (options) => {
          assert.equal(options.repositoryPath, directory);
          assert.equal(options.head, expectedSha);
          assert.equal(options.token, "token");
          return { tag: `paseo-v${latest}`, version: latest, lastReleaseSha };
        },
      });
    assert.deepEqual(await check(version), {
      ready: true,
      lastReleaseSha,
      reason: `Latest release paseo-v${version} maps to ${lastReleaseSha}`,
    });
    assert.deepEqual(await check("0.0.9"), {
      ready: false,
      lastReleaseSha,
      reason: `Merged version ${version} awaits publication; latest release is paseo-v0.0.9`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
