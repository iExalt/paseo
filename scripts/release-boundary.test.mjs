import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import {
  readReleaseBoundary,
  rebindReleaseBoundary,
  verifyBoundaryHistory,
} from "./release-boundary.mjs";
import { releaseVersionSelectors } from "../.github/scripts/release-version-selectors.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
test("release configuration owns exactly the fork version selectors and cannot publish", async () => {
  const { config, boundary } = await readReleaseBoundary(read);
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
  assert.deepEqual(config.packages["."]["extra-files"], releaseVersionSelectors(packages));
  assert.equal(config["skip-github-release"], true);
  const manifest = JSON.parse(await read(".release-please-manifest.json"));
  assert.deepEqual(Object.keys(manifest), ["."]);
  assert.ok([boundary.version, root.version].includes(manifest["."]));
  const workflow = load(await read(".github/workflows/release-please.yml"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["dev"]);
  assert.match(workflow.jobs.propose.if, /github.ref == 'refs\/heads\/dev'/);
  const release = workflow.jobs.propose.steps.find((step) =>
    step.uses?.startsWith("googleapis/release-please-action@"),
  );
  assert.equal(release.with["skip-github-release"], true);
  assert.equal(release.with.token, "${{ steps.app.outputs.token }}");
  const engine = JSON.parse(await read(".github/release-tools/package.json"));
  assert.equal(engine.dependencies["release-please"], "17.6.0");
});

test("missing or changed history fails closed while exact signed replay preserves original identity", async () => {
  const before = await readReleaseBoundary(read);
  const mapped = "b".repeat(40);
  const rebound = await rebindReleaseBoundary(
    before,
    new Map([[before.boundary.currentSha, mapped]]),
    async (sha) => sha === mapped,
  );
  assert.equal(rebound.boundary.originalSha, before.boundary.originalSha);
  assert.equal(rebound.config["last-release-sha"], mapped);
  await assert.rejects(
    rebindReleaseBoundary(before, new Map(), async () => false),
    /missing/,
  );
  await assert.rejects(
    readReleaseBoundary(async () => {
      throw new Error("missing file");
    }),
    /missing file/,
  );
  const fork = JSON.parse(await read(".github/fork-release.json"));
  const boundary = { ...rebound.boundary, kind: "bootstrap", version: "0.0.0" };
  const readAt = async (_sha, file) =>
    file === ".github/fork-release.json"
      ? JSON.stringify({ ...fork, version: "0.1.0" })
      : "unchanged changelog";
  await verifyBoundaryHistory(boundary, { isAncestor: async () => true, readAt });
  await assert.rejects(
    verifyBoundaryHistory(boundary, { isAncestor: async () => false, readAt }),
    /ancestor/,
  );
  await assert.rejects(
    verifyBoundaryHistory(boundary, {
      isAncestor: async () => true,
      readAt: async (sha, file) => (file === "CHANGELOG.fork.md" ? sha : readAt(sha, file)),
    }),
    /changelog/,
  );
  await assert.rejects(
    verifyBoundaryHistory(boundary, {
      isAncestor: async () => true,
      readAt: async (_sha, file) =>
        file === ".github/fork-release.json"
          ? JSON.stringify({ ...fork, version: "0.2.0" })
          : "unchanged changelog",
    }),
    /version differs/,
  );
});
