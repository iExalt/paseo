import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RECEIPT_PREFIX = "PASEO_CI_SOURCE=";
export function sourceReceipt(
  env,
  git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(),
) {
  const sha = git("rev-parse", "HEAD");
  const parents = git("show", "-s", "--format=%P", "HEAD").split(" ").filter(Boolean);
  let kind = env.GITHUB_EVENT_NAME === "pull_request" ? "routine-pr" : "routine-push";
  if (env.DEEP_LANE) kind = "deep";
  const integer = (value) => {
    assert.match(value ?? "", /^[1-9][0-9]*$/);
    const number = Number(value);
    assert.ok(Number.isSafeInteger(number));
    return number;
  };
  const receipt = {
    schemaVersion: 1,
    kind,
    repositoryId: integer(env.GITHUB_REPOSITORY_ID),
    runId: integer(env.GITHUB_RUN_ID),
    attempt: integer(env.GITHUB_RUN_ATTEMPT),
    prNumber: env.PR_NUMBER ? integer(env.PR_NUMBER) : null,
    sha,
    baseSha: env.PR_BASE_SHA || null,
    headSha: env.PR_HEAD_SHA || null,
    parents,
    lane: env.DEEP_LANE || null,
  };
  assert.equal(receipt.repositoryId, 1404390841);
  assert.match(sha, /^[a-f0-9]{40}$/);
  if (kind === "routine-pr") {
    assert.ok(receipt.prNumber);
    assert.match(receipt.baseSha, /^[a-f0-9]{40}$/);
    assert.match(receipt.headSha, /^[a-f0-9]{40}$/);
    assert.deepEqual(
      parents,
      [receipt.baseSha, receipt.headSha],
      "Routine PR checkout must merge the captured base and head",
    );
  } else if (kind === "deep") {
    assert.ok(["browser", "integration", "electron"].includes(receipt.lane));
    assert.equal(sha, env.SOURCE_SHA, "Deep checkout differs from authorized head");
  } else assert.equal(sha, env.GITHUB_SHA, "Push checkout differs from event source");
  return receipt;
}

export function readSourceReceipt(log, step) {
  assert.equal(step.status, "completed");
  assert.equal(step.conclusion, "success");
  const lines = log.split(/\r?\n/).filter((line) => line.includes(RECEIPT_PREFIX));
  assert.equal(lines.length, 1, "Expected exactly one setup source receipt");
  const match = lines[0].match(/^([0-9T:.Z-]+) PASEO_CI_SOURCE=(\{.*\})$/);
  assert.ok(match, "Malformed source receipt");
  const at = Date.parse(match[1]);
  assert.ok(
    at >= Date.parse(step.started_at) && at < Date.parse(step.completed_at) + 1000,
    "Receipt is outside controlled setup step",
  );
  const receipt = JSON.parse(match[2]);
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "schemaVersion",
      "kind",
      "repositoryId",
      "runId",
      "attempt",
      "prNumber",
      "sha",
      "baseSha",
      "headSha",
      "parents",
      "lane",
    ].sort(),
  );
  assert.equal(receipt.schemaVersion, 1);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(RECEIPT_PREFIX + JSON.stringify(sourceReceipt(process.env)));
