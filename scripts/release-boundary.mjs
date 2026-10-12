import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseForkVersion } from "./fork-version.mjs";
import {
  validateForkConfig,
  FORK_CONFIG_PATH,
  FORK_CHANGELOG_PATH,
} from "./fork-release-config.mjs";

export const RELEASE_BOUNDARY_PATH = ".github/release-boundary.json";
export const RELEASE_CONFIG_PATH = "release-please-config.json";
export const changelogDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateReleaseBoundary(value) {
  const keys = ["currentSha", "kind", "originalSha", "schemaVersion", "version"];
  if (value.kind === "bootstrap") keys.push("forkVersion", "changelogSha256");
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  assert.equal(value.schemaVersion, 1);
  assert.ok(value.kind === "bootstrap" || value.kind === "release");
  parseForkVersion(value.version);
  if (value.kind === "bootstrap") {
    assert.equal(value.version, "0.0.0");
    assert.equal(value.forkVersion, "0.1.0");
    assert.match(value.changelogSha256, /^[a-f0-9]{64}$/);
  } else assert.notEqual(value.version, "0.0.0");
  assert.match(value.originalSha, /^[a-f0-9]{40}$/);
  assert.match(value.currentSha, /^[a-f0-9]{40}$/);
  return value;
}

export async function readReleaseBoundary(read) {
  const boundary = validateReleaseBoundary(JSON.parse(await read(RELEASE_BOUNDARY_PATH)));
  const config = JSON.parse(await read(RELEASE_CONFIG_PATH));
  assert.equal(
    config["last-release-sha"],
    boundary.currentSha,
    "Release history must stop at the recorded boundary",
  );
  if (boundary.kind === "bootstrap") assert.equal(config["bootstrap-sha"], boundary.currentSha);
  return { boundary, config };
}

export async function rebindReleaseBoundary(before, rewritten, isAncestor) {
  const currentSha = rewritten.get(before.boundary.currentSha) ?? before.boundary.currentSha;
  assert.ok(
    await isAncestor(currentSha),
    "Release boundary is missing from the signed replay; refusing an unrestricted history scan",
  );
  const boundary = { ...before.boundary, currentSha };
  const config = { ...before.config, "last-release-sha": currentSha };
  if (boundary.kind === "bootstrap") config["bootstrap-sha"] = currentSha;
  return { boundary, config };
}

export async function verifyBoundaryHistory(boundary, { isAncestor, readAt }) {
  assert.ok(
    await isAncestor(boundary.currentSha),
    "Recorded release boundary is not an ancestor of the target",
  );
  const bootstrap = boundary.kind === "bootstrap";
  const expectedVersion = bootstrap ? boundary.forkVersion : boundary.version;
  const commits = bootstrap ? [boundary.currentSha] : [boundary.originalSha, boundary.currentSha];
  for (const sha of new Set(commits)) {
    const config = validateForkConfig(JSON.parse(await readAt(sha, FORK_CONFIG_PATH)));
    assert.equal(config.version, expectedVersion, "Release boundary source version differs");
    if (boundary.kind === "release")
      assert.equal(
        JSON.parse(await readAt(sha, ".release-please-manifest.json"))["."],
        boundary.version,
      );
  }
  if (bootstrap) {
    assert.equal(
      changelogDigest(await readAt(boundary.currentSha, FORK_CHANGELOG_PATH)),
      boundary.changelogSha256,
      "Replayed bootstrap changed fork changelog history",
    );
    return;
  }
  assert.equal(
    await readAt(boundary.currentSha, FORK_CHANGELOG_PATH),
    await readAt(boundary.originalSha, FORK_CHANGELOG_PATH),
    "Replayed boundary changed fork changelog history",
  );
}
