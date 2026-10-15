import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Manifest } from "release-please";
import { releaseManifest } from "./proposal-prepare.mjs";
import { inspectForkRelease } from "../../scripts/fork-release-config.mjs";
import { releaseVersionSelectors } from "../scripts/release-version-selectors.mjs";
import { composeProposalTree, lockDigest, verifyProposalLock } from "./proposal-tree.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFile(`${root}${file}`, "utf8");
const initialConfig = JSON.parse(await read("release-please-config.json"));
const rootPackage = JSON.parse(await read("package.json"));
const packages = [
  ["", rootPackage],
  ...(await Promise.all(
    rootPackage.workspaces.map(async (directory) => [
      directory,
      JSON.parse(await read(`${directory}/package.json`)),
    ]),
  )),
];
const files = new Map(
  await Promise.all(
    [
      "release-please-config.json",
      ".release-please-manifest.json",
      ".github/fork-release.json",
      "package-lock.json",
      "CHANGELOG.fork.md",
      "package.json",
      "nix/npm-deps.hash",
      ...rootPackage.workspaces.map((directory) => `${directory}/package.json`),
    ].map(async (file) => [file, await read(file)]),
  ),
);
const oldUpstreamSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const commit = (sha, message) => ({ sha, message, files: ["packages/server/src/index.ts"] });

async function proposal(contents, boundary, previousRelease) {
  let stopped = false;
  const github = {
    repository: { owner: "iExalt", repo: "paseo" },
    async getFileJson(file) {
      return JSON.parse(contents.get(file));
    },
    async getFileContentsOnBranch(file) {
      assert.ok(contents.has(file), `Unexpected engine file request: ${file}`);
      const parsedContent = contents.get(file);
      return { parsedContent, content: Buffer.from(parsedContent).toString("base64") };
    },
    async *releaseIterator() {
      if (previousRelease) yield previousRelease;
      yield {
        tagName: "v0.11.2",
        sha: oldUpstreamSha,
        name: "upstream release",
        notes: "upstream history",
      };
      yield {
        tagName: "paseo-fork-v0.11.0-r200008",
        sha: oldUpstreamSha,
        name: "historical sequence",
      };
    },
    async *tagIterator() {
      yield { name: "v0.11.2", sha: oldUpstreamSha };
      yield { name: "v0.1.1", sha: oldUpstreamSha };
    },
    async *mergeCommitIterator() {
      yield commit("d".repeat(40), "fix: preserve fork state");
      yield commit(boundary, "feat: bootstrap boundary excluded from notes");
      stopped = true;
      yield commit(oldUpstreamSha, "feat: forbidden upstream history");
    },
  };
  const manifest = await releaseManifest(github, "dev", boundary);
  const proposals = await manifest.buildPullRequests();
  assert.equal(proposals.length, 1);
  assert.equal(stopped, false, "Engine must stop at the explicit boundary");
  const result = proposals[0];
  github.pullRequestIterator = async function* () {
    yield {
      number: 1,
      title: result.title.toString(),
      body: result.body.toString(),
      headBranchName: result.headRefName,
      sha: mergeSha,
      labels: ["autorelease: pending"],
    };
  };
  assert.deepEqual(await manifest.buildReleases(), [], "Production configuration cannot release");
  // Exercise tag composition offline without calling createReleases or any API.
  const tagManifest = await Manifest.fromManifest(
    {
      ...github,
      async getFileJson(file) {
        const value = await github.getFileJson(file);
        return file === "release-please-config.json"
          ? { ...value, "skip-github-release": false }
          : value;
      },
    },
    "dev",
    undefined,
    undefined,
    { lastReleaseSha: boundary },
  );
  const releases = await tagManifest.buildReleases();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].tag.toString(), `paseo-v${result.version.toString()}`);
  assert.doesNotMatch(
    result.body.toString(),
    /forbidden upstream|bootstrap boundary|Generated with|generated with|beep/,
  );
  let fetchedLock;
  const readProposal = async (file) => {
    if (!contents.has(file)) throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
    return contents.get(file);
  };
  const prepared = await composeProposalTree(result, readProposal, async (lock) => {
    fetchedLock = lock;
    assert.equal(JSON.parse(lock).version, result.version.toString());
    // This fixture tests input binding, not the Nix fetcher's hash algorithm.
    return `sha256-${Buffer.from(lockDigest(lock), "hex").toString("base64")}`;
  });
  verifyProposalLock(prepared);
  assert.equal(prepared.files.get("package-lock.json"), fetchedLock);
  const changed = { ...prepared, files: new Map(prepared.files) };
  changed.files.set("package-lock.json", `${fetchedLock}\n`);
  assert.throws(() => verifyProposalLock(changed));
  await assert.rejects(
    composeProposalTree(result, readProposal, async () => {
      throw new Error("fetch failed");
    }),
    /fetch failed/,
  );
  for (const [file, content] of prepared.files) contents.set(file, content);
  await inspectForkRelease(async (file) => contents.get(file));
  return result;
}

test("pinned release engine composes all version edits and bounds both proposals", async () => {
  assert.deepEqual(initialConfig.packages["."]["extra-files"], releaseVersionSelectors(packages));
  const contents = new Map(files);
  // Rehearse the bootstrap even after the real manifest has advanced.
  const bootstrap = structuredClone(initialConfig);
  bootstrap.packages["."]["release-as"] = "0.1.0";
  contents.set("release-please-config.json", JSON.stringify(bootstrap));
  contents.set(".release-please-manifest.json", JSON.stringify({ ".": "0.0.0" }));
  const first = await proposal(contents, initialConfig["bootstrap-sha"]);
  assert.equal(first.version.toString(), "0.1.0");
  assert.equal(first.headRefName, "release-please--branches--dev--components--paseo");
  const config = JSON.parse(contents.get("release-please-config.json"));
  delete config.packages["."]["release-as"];
  contents.set("release-please-config.json", JSON.stringify(config));
  const rehearsalContents = new Map(contents);
  const second = await proposal(contents, mergeSha, {
    tagName: "paseo-v0.1.0",
    sha: "e".repeat(40),
    name: "prior fork release outside rebased ancestry",
    notes: "previous fork notes",
  });
  assert.equal(second.version.toString(), "0.1.1");
  const unpublished = await proposal(rehearsalContents, mergeSha);
  assert.equal(
    unpublished.version.toString(),
    "0.1.1",
    "The unpublished rehearsal needs no fabricated GitHub release",
  );
  const beforeLock = JSON.parse(files.get("package-lock.json"));
  const afterLock = JSON.parse(contents.get("package-lock.json"));
  for (const [key, value] of Object.entries(beforeLock.packages)) {
    if (key.startsWith("node_modules/"))
      assert.deepEqual(afterLock.packages[key], value, `External resolution changed: ${key}`);
  }
});
