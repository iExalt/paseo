import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { compareForkVersions, forkVersionFromTag } from "./fork-version.mjs";
import { validateForkConfig, FORK_CONFIG_PATH } from "./fork-release-config.mjs";
import { latestVerifiedRelease } from "./paseo-nix-update.mjs";

export const RELEASE_CONFIG_PATH = "release-please-config.json";
const RELEASES_PATH = "/repos/iExalt/paseo/releases";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// The release boundary is derived from the newest published fork release, not
// from committed state. Other tags (fixtures, dry runs, candidates, upstream)
// share the Releases API but never name a fork version.
export function latestForkReleaseTag(releases) {
  let latest = null;
  for (const release of releases) {
    if (release.draft !== false || release.prerelease !== false) continue;
    const version = forkVersionFromTag(release.tag_name);
    if (version === null) continue;
    assert.notEqual(latest?.version, version, `Duplicate published release ${release.tag_name}`);
    if (latest === null || compareForkVersions(version, latest.version) > 0)
      latest = { tag: release.tag_name, version };
  }
  assert.ok(latest, "No published paseo-v<semver> release exists");
  return latest.tag;
}

async function listReleases(request, token) {
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await request(`${RELEASES_PATH}?per_page=${PAGE_SIZE}&page=${page}`, token);
    assert.ok(Array.isArray(rows), "Releases API returned an unexpected response");
    releases.push(...rows);
    if (rows.length < PAGE_SIZE) return releases;
  }
  throw new Error("Release history exceeds the bounded Releases API scan");
}

// release-please proposals merge as "release". A merged version whose release
// commit could not ship is published from a hand-made "replace pending release"
// repair commit (paseo-v0.1.1 was), so both subjects identify a release commit.
function releaseCommitSubjects(version) {
  return [`chore(dev): release ${version}`, `chore(dev): replace pending release ${version}`];
}

function gitIn(repositoryPath) {
  return (...args) =>
    execFileSync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
}

// Zero context keeps the identity to the changed lines, so unrelated upstream
// edits near a version field cannot change it across a replay.
function patchId(git, sha) {
  const diff = git(
    "diff-tree",
    "--patch",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--full-index",
    "--root",
    sha,
  );
  const result = execFileSync("git", ["patch-id", "--stable"], { input: diff, encoding: "utf8" });
  const id = result.trim().split(/\s+/)[0];
  assert.match(id ?? "", /^[a-f0-9]{40,64}$/, `Release commit ${sha} has no patch`);
  return id;
}

// rebase-dev replays fork commits onto upstream, so the published tag may name
// a commit outside dev. The replay keeps messages byte-for-byte and patches
// stable, so the release commit is identified by its exact subject and
// confirmed by full message and stable patch-id. Anything else fails closed.
export function mapReleaseCommit({ repositoryPath, head, version, tagSha }) {
  const git = gitIn(repositoryPath);
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(tagSha, /^[a-f0-9]{40}$/);
  const subject = git("log", "-1", "--format=%s", tagSha).trim();
  assert.ok(
    releaseCommitSubjects(version).includes(subject),
    `Release ${version} tag names commit ${tagSha} ("${subject}"), not a release commit`,
  );
  const candidates = git(
    "log",
    "--format=%H%x00%s",
    "--fixed-strings",
    `--grep=${subject}`,
    head,
    "--",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))
    .filter(([, candidateSubject]) => candidateSubject === subject)
    .map(([sha]) => sha);
  assert.equal(
    candidates.length,
    1,
    candidates.length === 0
      ? `No commit on ${head} has subject "${subject}"; cannot map release ${version}`
      : `Commits ${candidates.join(", ")} all have subject "${subject}"; release ${version} is ambiguous`,
  );
  const [mapped] = candidates;
  const tagOnTarget =
    spawnSync("git", ["merge-base", "--is-ancestor", tagSha, head], { cwd: repositoryPath })
      .status === 0;
  if (tagOnTarget)
    assert.equal(mapped, tagSha, `Release ${version} tag commit is on the target but not mapped`);
  else {
    const message = (sha) => git("cat-file", "commit", sha).replace(/^[\s\S]*?\n\n/, "");
    assert.equal(message(mapped), message(tagSha), `Release ${version} commit message changed`);
    assert.equal(
      patchId(git, mapped),
      patchId(git, tagSha),
      `Release ${version} commit ${mapped} has a different patch than ${tagSha}`,
    );
  }
  const readAt = (file) => git("show", `${mapped}:${file}`);
  assert.equal(validateForkConfig(JSON.parse(readAt(FORK_CONFIG_PATH))).version, version);
  assert.deepEqual(JSON.parse(readAt(".release-please-manifest.json")), { ".": version });
  return mapped;
}

export async function deriveReleaseBoundary({
  repositoryPath,
  head,
  token,
  request,
  fetchBytes,
  publicKey,
}) {
  const tag = latestForkReleaseTag(await listReleases(request, token));
  const { manifest } = await latestVerifiedRelease({
    resolveTag: async () => tag,
    fetchBytes,
    publicKey,
  });
  const tagSha = gitIn(repositoryPath)("rev-parse", "--verify", `refs/tags/${tag}^{commit}`).trim();
  assert.equal(tagSha, manifest.sourceSha, `Tag ${tag} does not name the signed source commit`);
  const lastReleaseSha = mapReleaseCommit({
    repositoryPath,
    head,
    version: manifest.version,
    tagSha,
  });
  return { tag, version: manifest.version, tagSha, lastReleaseSha };
}
