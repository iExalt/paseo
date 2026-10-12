import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import {
  readReleaseBoundary,
  rebindReleaseBoundary,
  verifyBoundaryHistory,
  changelogDigest,
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
  const eligible = new Function(
    "github",
    "inputs",
    "vars",
    `return (${workflow.jobs.propose.if});`,
  );
  const event = {
    repository: "iExalt/paseo",
    event: { repository: { private: false } },
    ref: "refs/heads/dev",
    event_name: "push",
    actor: "iExalt",
  };
  assert.equal(eligible(event, {}, {}), false);
  assert.equal(eligible(event, {}, { PASEO_RELEASE_PROPOSALS_ENABLED: "true" }), true);
  event.event_name = "workflow_dispatch";
  assert.equal(eligible(event, { target: "dev" }, {}), false);
  assert.equal(eligible(event, { target: "ci/release-please-rehearsal" }, {}), true);
  assert.equal(
    eligible({ ...event, actor: "other" }, { target: "ci/release-please-rehearsal" }, {}),
    false,
  );
  const steps = workflow.jobs.propose.steps;
  const release = steps.find((step) => step.run === "node .github/release-tools/proposal-run.mjs");
  const prepare = steps.find((step) => step.id === "prepare");
  assert.equal(release.env.RELEASE_APP_TOKEN, "${{ steps.app.outputs.token }}");
  assert.equal(release.env.TARGET_SHA, "${{ steps.target.outputs.sha }}");
  assert.equal(prepare.env.TARGET_SHA, release.env.TARGET_SHA);
  assert.equal(prepare.env.TARGET_DIRECTORY, release.env.TARGET_DIRECTORY);
  assert.equal(prepare.env.PREPARED_PROPOSAL, release.env.PREPARED_PROPOSAL);
  assert.equal(prepare.run, "node .github/release-tools/proposal-prepare.mjs");
  assert.equal(prepare.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(prepare.env.RELEASE_APP_TOKEN, undefined);
  assert.ok(steps.indexOf(prepare) < steps.findIndex((step) => step.id === "identity"));
  assert.ok(steps.indexOf(prepare) < steps.findIndex((step) => step.id === "app"));
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
  const boundary = {
    ...rebound.boundary,
    kind: "bootstrap",
    version: "0.0.0",
    forkVersion: "0.1.0",
    changelogSha256: changelogDigest("unchanged changelog"),
  };
  const readAt = async (_sha, file) =>
    file === ".github/fork-release.json"
      ? JSON.stringify({ ...fork, version: "0.1.0" })
      : "unchanged changelog";
  await verifyBoundaryHistory(boundary, { isAncestor: async () => true, readAt });
  await assert.rejects(
    verifyBoundaryHistory(
      { ...boundary, changelogSha256: "f".repeat(64) },
      { isAncestor: async () => true, readAt },
    ),
    /changelog/,
  );
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
