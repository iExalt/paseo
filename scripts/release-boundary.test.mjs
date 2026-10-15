import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { load } from "js-yaml";
import {
  RELEASE_CONFIG_PATH,
  deriveReleaseBoundary,
  latestForkReleaseTag,
  mapReleaseCommit,
} from "./release-boundary.mjs";
import { forkReleaseManifestFixture } from "./test-fixtures/fork-release-manifest.ts";
import { releaseVersionSelectors } from "../.github/scripts/release-version-selectors.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
test("release configuration owns exactly the fork version selectors and cannot publish", async () => {
  const config = JSON.parse(await read(RELEASE_CONFIG_PATH));
  // The boundary is derived from the latest published release, never recorded.
  assert.equal(config["last-release-sha"], undefined);
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
  assert.equal(manifest["."], root.version);
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

test("latest release is the highest published paseo-v semver, ignoring other releases", () => {
  const release = (tag_name, draft = false, prerelease = false) => ({
    tag_name,
    draft,
    prerelease,
  });
  const releases = [
    release("paseo-v0.1.9"),
    release("paseo-v0.1.10"),
    release("paseo-v0.3.0", true),
    release("paseo-v0.4.0", false, true),
    release("paseo-dryrun-v0.9.0"),
    release("paseo-candidate-v0.5.0-" + "a".repeat(40)),
    release("ci-upgrade-fixtures-v0.6.0"),
    release("paseo-v0.7"),
    release("v0.11.2"),
  ];
  assert.equal(latestForkReleaseTag(releases), "paseo-v0.1.10");
  assert.throws(() => latestForkReleaseTag(releases.slice(2)), /No published/);
});

// One repository holds the published history and its rebased replay:
//   base - A "chore(dev): release 0.1.1" (tagged) - B          (published)
//   base - U - A' - B'                                         (rebased dev)
const fixture = {};
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-release-boundary-"));
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
  const commit = async (message, files) => {
    for (const [file, content] of Object.entries(files))
      await writeFile(join(directory, file), content);
    git("add", ".");
    git("commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const fork = JSON.parse(await read(".github/fork-release.json"));
  const releaseFiles = (version) => ({
    ".github/fork-release.json": JSON.stringify({ ...fork, version }, null, 2),
    ".release-please-manifest.json": JSON.stringify({ ".": version }),
  });
  git("init", "--quiet", "--initial-branch=published");
  await mkdir(join(directory, ".github"));
  const base = await commit("chore: base", { ...releaseFiles("0.1.0"), "other.txt": "a\n" });
  const releaseMessage = "chore(dev): release 0.1.1\n\nRelease notes body.";
  const original = await commit(releaseMessage, releaseFiles("0.1.1"));
  git("tag", "paseo-v0.1.1", original);
  const published = await commit("fix: after release", { "other.txt": "b\n" });
  git("checkout", "--quiet", "-b", "upstream", base);
  await commit("feat: upstream change", { "upstream.txt": "u\n" });
  git("checkout", "--quiet", "-b", "dev", published);
  git("rebase", "--quiet", "upstream");
  const head = git("rev-parse", "HEAD");
  const replayed = git("rev-parse", "HEAD~1");
  Object.assign(fixture, { directory, git, commit, original, published, head, replayed });
});
after(() => rm(fixture.directory, { recursive: true, force: true }));

test("a release commit on the target maps to itself, and a non-release tag commit fails", () => {
  const { directory, original, published } = fixture;
  const map = (tagSha) =>
    mapReleaseCommit({ repositoryPath: directory, head: published, version: "0.1.1", tagSha });
  assert.equal(map(original), original);
  assert.throws(() => map(published), /not a release commit/);
});

test("a rebased release commit maps by exact subject, message and patch-id", () => {
  const { directory, original, head, replayed } = fixture;
  assert.notEqual(replayed, original);
  assert.equal(
    mapReleaseCommit({ repositoryPath: directory, head, version: "0.1.1", tagSha: original }),
    replayed,
  );
});

test("a missing, ambiguous or repatched release commit fails closed", async () => {
  const { directory, git, commit, original, head } = fixture;
  const map = (target) =>
    mapReleaseCommit({
      repositoryPath: directory,
      head: target,
      version: "0.1.1",
      tagSha: original,
    });
  assert.throws(() => map(git("rev-parse", "upstream")), /No commit/);
  git("checkout", "--quiet", "-b", "ambiguous", head);
  const duplicate = await commit("chore(dev): release 0.1.1\n\nRelease notes body.", {});
  assert.throws(() => map(duplicate), /ambiguous/);
  git("checkout", "--quiet", "-b", "repatched", "upstream");
  const changed = await commit("chore(dev): release 0.1.1\n\nRelease notes body.", {
    ".github/fork-release.json": git("show", `${original}:.github/fork-release.json`),
    ".release-please-manifest.json": git("show", `${original}:.release-please-manifest.json`),
    "extra.txt": "not in the release\n",
  });
  assert.throws(() => map(changed), /different patch/);
});

test("the signed latest release must verify and name its own tag and source", async () => {
  const { directory, original, head, replayed } = fixture;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const signed = (manifest, signer = keys.privateKey) => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    return { bytes, signature: Buffer.from(sign(null, bytes, signer).toString("base64url")) };
  };
  const derive = (tag, { bytes, signature }) =>
    deriveReleaseBoundary({
      repositoryPath: directory,
      head,
      token: "token",
      publicKey,
      request: async (path, token) => {
        assert.equal(token, "token");
        assert.match(path, /^\/repos\/iExalt\/paseo\/releases\?per_page=100&page=1$/);
        return [{ tag_name: tag, draft: false, prerelease: false }];
      },
      fetchBytes: async (url) => {
        assert.ok(url.includes(`/download/${tag}/`));
        return url.endsWith(".sig") ? signature : bytes;
      },
    });
  const manifest = { ...forkReleaseManifestFixture("0.1.1"), sourceSha: original };
  assert.deepEqual(await derive("paseo-v0.1.1", signed(manifest)), {
    tag: "paseo-v0.1.1",
    version: "0.1.1",
    tagSha: original,
    lastReleaseSha: replayed,
  });
  await assert.rejects(
    derive("paseo-v0.1.1", signed(manifest, generateKeyPairSync("ed25519").privateKey)),
    /signature/,
  );
  const other = forkReleaseManifestFixture("0.1.2");
  await assert.rejects(derive("paseo-v0.1.1", signed(other)), /names another release/);
  await assert.rejects(
    derive("paseo-v0.1.1", signed({ ...manifest, sourceSha: "f".repeat(40) })),
    /signed source commit/,
  );
});
