import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Manifest } from "release-please";
import { inspectForkRelease } from "../../scripts/fork-release-config.mjs";
import { releaseVersionSelectors } from "../scripts/release-version-selectors.mjs";

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
    },
    async *mergeCommitIterator() {
      yield commit("d".repeat(40), "fix: preserve fork state");
      yield commit(boundary, "feat: bootstrap boundary excluded from notes");
      stopped = true;
      yield commit(oldUpstreamSha, "feat: forbidden upstream history");
    },
  };
  const manifest = await Manifest.fromManifest(github, "dev");
  const proposals = await manifest.buildPullRequests();
  assert.equal(proposals.length, 1);
  assert.equal(stopped, false, "Engine must stop at the explicit boundary");
  const result = proposals[0];
  assert.doesNotMatch(
    result.body.toString(),
    /forbidden upstream|bootstrap boundary|Generated with|generated with|beep/,
  );
  for (const update of result.updates) {
    if (!contents.has(update.path) && !update.createIfMissing) continue;
    contents.set(update.path, update.updater.updateContent(contents.get(update.path)));
  }
  await inspectForkRelease(async (file) => contents.get(file));
  return result;
}

test("pinned release engine composes all version edits and bounds both proposals", async () => {
  assert.deepEqual(initialConfig.packages["."]["extra-files"], releaseVersionSelectors(packages));
  const contents = new Map(files);
  // Rehearse the bootstrap even after the real manifest has advanced.
  const bootstrap = structuredClone(initialConfig);
  bootstrap.packages["."]["release-as"] = "0.1.0";
  bootstrap["last-release-sha"] = bootstrap["bootstrap-sha"];
  contents.set("release-please-config.json", JSON.stringify(bootstrap));
  contents.set(".release-please-manifest.json", JSON.stringify({ ".": "0.0.0" }));
  const first = await proposal(contents, initialConfig["bootstrap-sha"]);
  assert.equal(first.version.toString(), "0.1.0");
  assert.equal(first.headRefName, "release-please--branches--dev--components--paseo");
  const config = JSON.parse(contents.get("release-please-config.json"));
  delete config.packages["."]["release-as"];
  config["last-release-sha"] = mergeSha;
  contents.set("release-please-config.json", JSON.stringify(config));
  const rehearsalContents = new Map(contents);
  const second = await proposal(contents, mergeSha, {
    tagName: "v0.1.0",
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
