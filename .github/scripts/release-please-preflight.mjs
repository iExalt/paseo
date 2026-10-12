import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectForkRelease } from "../../scripts/fork-release-config.mjs";
import { readReleaseBoundary, verifyBoundaryHistory } from "../../scripts/release-boundary.mjs";
import { releaseVersionSelectors } from "./release-version-selectors.mjs";
import { githubRequest } from "./release-app-auth.mjs";
import { forkReleaseTag } from "../../scripts/fork-version.mjs";

export const REHEARSAL_BRANCH = "ci/release-please-rehearsal";

export async function releasePreflight({
  repositoryPath,
  branch,
  expectedSha,
  token,
  request = githubRequest,
}) {
  assert.ok(branch === "dev" || branch === REHEARSAL_BRANCH);
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), expectedSha);
  assert.equal(git("status", "--porcelain"), "", "Release target must be clean");
  const read = (file) => readFile(resolve(repositoryPath, file), "utf8");
  const fork = await inspectForkRelease(read);
  const state = await readReleaseBoundary(read);
  await verifyBoundaryHistory(state.boundary, {
    isAncestor: async (sha) =>
      spawnSync("git", ["merge-base", "--is-ancestor", sha, expectedSha], { cwd: repositoryPath })
        .status === 0,
    readAt: async (sha, file) =>
      execFileSync("git", ["show", `${sha}:${file}`], { cwd: repositoryPath, encoding: "utf8" }),
  });
  const root = JSON.parse(await read("package.json"));
  const packages = [
    ["", root],
    ...(await Promise.all(
      root.workspaces.map(async (directory) => [
        directory,
        JSON.parse(await read(`${directory}/package.json`)),
      ]),
    )),
  ];
  const expected = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../release-please-config.json", import.meta.url)),
      "utf8",
    ),
  );
  expected["bootstrap-sha"] = state.config["bootstrap-sha"];
  expected["last-release-sha"] = state.boundary.currentSha;
  expected.packages["."]["extra-files"] = releaseVersionSelectors(packages);
  if (state.boundary.kind === "release") delete expected.packages["."]["release-as"];
  else expected.packages["."]["release-as"] = "0.1.0";
  assert.deepEqual(
    state.config,
    expected,
    "Target release configuration differs from reviewed policy",
  );
  const manifest = JSON.parse(await read(".release-please-manifest.json"));
  assert.deepEqual(Object.keys(manifest), ["."]);
  if (manifest["."] !== state.boundary.version) {
    assert.equal(manifest["."], fork.config.version, "Unrecognized pending version");
    return {
      ready: false,
      reason: "A merged version proposal awaits verified publication and boundary handoff",
    };
  }
  if (state.boundary.kind === "release" && branch === "dev") {
    const tag = forkReleaseTag(state.boundary.version);
    const release = await request(`/repos/iExalt/paseo/releases/tags/${tag}`, token);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    assert.equal(release.tag_name, tag);
    assert.equal(
      git("rev-parse", `refs/tags/${tag}^{commit}`),
      state.boundary.originalSha,
      "Published tag does not bind the original release boundary",
    );
  }
  return {
    ready: true,
    reason:
      branch === REHEARSAL_BRANCH
        ? "Isolated rehearsal; release boundary may be simulated"
        : "Recorded release boundary verified",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await releasePreflight({
    repositoryPath: process.env.TARGET_DIRECTORY,
    branch: process.env.TARGET_BRANCH,
    expectedSha: process.env.TARGET_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  await appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\n`);
  console.log(result.reason);
}
