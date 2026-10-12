import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  githubRequest,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_ID,
  releaseBotIdentity,
} from "./release-app-auth.mjs";

export function assertReleasePr(pr, identity, expectedSha) {
  assert.equal(pr.state, "open");
  assert.equal(pr.user.id, identity.botId);
  assert.equal(pr.user.login, identity.botLogin);
  assert.equal(pr.user.type, "Bot");
  for (const side of [pr.base, pr.head]) {
    assert.equal(side.repo.id, RELEASE_REPOSITORY_ID);
    assert.equal(side.repo.full_name, RELEASE_REPOSITORY);
    assert.equal(side.repo.private, false);
  }
  assert.ok(["dev", "ci/release-please-rehearsal"].includes(pr.base.ref));
  assert.equal(pr.head.ref, `release-please--branches--${pr.base.ref}--components--paseo`);
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  assert.equal(pr.head.sha, expectedSha, "PR head changed; fresh verification required");
  assert.ok(pr.labels.some((label) => label.name === "autorelease: pending"));
  return expectedSha;
}

export async function authorizeReleasePr(event, env, request = githubRequest) {
  assert.equal(event.repository.id, RELEASE_REPOSITORY_ID);
  assert.equal(event.repository.full_name, RELEASE_REPOSITORY);
  assert.equal(event.repository.private, false);
  const number = event.pull_request.number;
  assert.ok(Number.isSafeInteger(number) && number > 0);
  const current = await request(`/repos/${RELEASE_REPOSITORY}/pulls/${number}`, env.GITHUB_TOKEN);
  assert.equal(current.number, number);
  return assertReleasePr(current, releaseBotIdentity(env), event.pull_request.head.sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const sha = await authorizeReleasePr(event, process.env);
  await appendFile(process.env.GITHUB_OUTPUT, `allowed=true\nsha=${sha}\n`);
}
