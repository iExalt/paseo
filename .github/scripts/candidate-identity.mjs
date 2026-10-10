import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forkAndroidVersionCode, parseForkVersion } from "../../scripts/fork-version.mjs";

export function candidateIdentity(sha, version, cwd = process.cwd()) {
  assert.match(sha, /^[a-f0-9]{40}$/, "Candidate source must be a full SHA");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), sha, "Candidate source differs from checkout");
  assert.equal(git("status", "--porcelain"), "", "Candidate checkout must be clean");
  const sourceVersion = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")).version;
  parseForkVersion(sourceVersion);
  if (version !== undefined)
    assert.equal(version, sourceVersion, "Candidate version differs from source");
  return {
    source_sha: sha,
    fork_version: sourceVersion,
    version_code: forkAndroidVersionCode(sourceVersion),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 || process.argv.length === 4);
  for (const [key, value] of Object.entries(candidateIdentity(process.argv[2], process.argv[3]))) {
    console.log(`${key}=${value}`);
  }
}
