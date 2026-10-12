import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateRoute, currentCandidate, newCandidate } from "./candidate-authority.mjs";
import { descriptorDigest, signDescriptor } from "./candidate-descriptor.mjs";
import { eligibleDraft, ensureDraft, loadDescriptor } from "./candidate-draft.mjs";
import { candidateGithub } from "./candidate-github.mjs";
import { releaseBotIdentity } from "./release-app-auth.mjs";
import { readGithub } from "./release-pr-checks.mjs";

export async function candidateEntry({ event, env, read, request, api, output }) {
  assert.ok(["plan", "issue"].includes(env.CANDIDATE_MODE));
  const route = candidateRoute(event, env);
  const identity = releaseBotIdentity(env);
  const descriptor = route.releaseId
    ? await loadDescriptor(api, route.releaseId)
    : await newCandidate(route, env.GITHUB_SHA, identity, request, read);
  await currentCandidate(descriptor, env.GITHUB_SHA, identity, request, read);
  await eligibleDraft(api, descriptor, route.releaseId);
  const digest = descriptorDigest(descriptor);
  if (env.CANDIDATE_MODE === "issue") {
    assert.equal(digest, env.EXPECTED_DESCRIPTOR_DIGEST, "Plan changed before issuance");
    let releaseId = route.releaseId;
    if (!releaseId) {
      const signature = signDescriptor(
        descriptor,
        env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY,
        api.publicPin,
      );
      releaseId = await ensureDraft(api, descriptor, signature);
    }
    await output(`release_id=${releaseId}\n`);
  }
  await output(
    `descriptor_digest=${digest}\nsource_sha=${descriptor.sourceSha}\nversion=${descriptor.version}\n`,
  );
  return descriptor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.GITHUB_SHA,
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
    }).trim(),
    "",
  );
  const read = async (sha, file) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert.match(file, /^[a-zA-Z0-9._/-]+$/);
    return execFileSync("git", ["show", `${sha}:${file}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
    });
  };
  await candidateEntry({
    event: JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")),
    env,
    read,
    request: readGithub,
    api: candidateGithub(env.GH_TOKEN),
    output: (text) => appendFile(env.GITHUB_OUTPUT, text),
  });
}
