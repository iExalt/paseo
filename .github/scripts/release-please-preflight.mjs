import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectForkRelease } from "../../scripts/fork-release-config.mjs";
import { deriveReleaseBoundary, RELEASE_CONFIG_PATH } from "../../scripts/release-boundary.mjs";
import { releaseVersionSelectors } from "./release-version-selectors.mjs";
import { githubRequest } from "./release-app-auth.mjs";

export const REHEARSAL_BRANCH = "ci/release-please-rehearsal";

export async function releasePreflight({
  repositoryPath,
  branch,
  expectedSha,
  token,
  request = githubRequest,
  fetchBytes,
  publicKey,
  deriveBoundary = deriveReleaseBoundary,
}) {
  assert.ok(branch === "dev" || branch === REHEARSAL_BRANCH);
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), expectedSha);
  assert.equal(git("status", "--porcelain"), "", "Release target must be clean");
  const read = (file) => readFile(resolve(repositoryPath, file), "utf8");
  const fork = await inspectForkRelease(read);
  const boundary = await deriveBoundary({
    repositoryPath,
    head: expectedSha,
    token,
    request,
    fetchBytes,
    publicKey,
  });
  const config = JSON.parse(await read(RELEASE_CONFIG_PATH));
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
  expected["bootstrap-sha"] = config["bootstrap-sha"];
  expected.packages["."]["extra-files"] = releaseVersionSelectors(packages);
  assert.deepEqual(config, expected, "Target release configuration differs from reviewed policy");
  const manifest = JSON.parse(await read(".release-please-manifest.json"));
  assert.deepEqual(Object.keys(manifest), ["."]);
  const { lastReleaseSha } = boundary;
  if (manifest["."] !== boundary.version) {
    assert.equal(manifest["."], fork.config.version, "Unrecognized pending version");
    return {
      ready: false,
      lastReleaseSha,
      reason: `Merged version ${manifest["."]} awaits publication; latest release is ${boundary.tag}`,
    };
  }
  return {
    ready: true,
    lastReleaseSha,
    reason: `Latest release ${boundary.tag} maps to ${lastReleaseSha}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await releasePreflight({
    repositoryPath: process.env.TARGET_DIRECTORY,
    branch: process.env.TARGET_BRANCH,
    expectedSha: process.env.TARGET_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `ready=${result.ready}\nlast_release_sha=${result.lastReleaseSha}\n`,
  );
  console.log(result.reason);
}
