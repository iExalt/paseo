import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  releaseBotIdentity,
  verifyReleaseApp,
  verifyInstallationToken,
} from "../.github/scripts/release-app-auth.mjs";
import { assertReleasePr, authorizeReleasePr } from "../.github/scripts/release-pr.mjs";

const env = {
  PASEO_RELEASE_APP_ID: "123",
  PASEO_RELEASE_APP_CLIENT_ID: "Iv1.fixture",
  PASEO_RELEASE_BOT_ID: "456",
  PASEO_RELEASE_BOT_LOGIN: "paseo-release[bot]",
};
const identity = releaseBotIdentity(env);
const sha = "a".repeat(40);
const repo = { id: 1404390841, full_name: "iExalt/paseo", private: false };
const pr = {
  number: 7,
  state: "open",
  user: { id: 456, login: identity.botLogin, type: "Bot" },
  base: { repo, ref: "dev" },
  head: { repo, ref: "release-please--branches--dev--components--paseo", sha },
  labels: [{ name: "autorelease: pending" }],
};

test("bot PR authority rejects forged labels, identity, repository and stale heads", async () => {
  assert.equal(assertReleasePr(pr, identity, sha), sha);
  for (const mutate of [
    (p) => {
      p.user.id++;
    },
    (p) => {
      p.user.login = "other[bot]";
    },
    (p) => {
      p.user.type = "User";
    },
    (p) => {
      p.head.repo.id++;
    },
    (p) => {
      p.base.ref = "main";
    },
    (p) => {
      p.head.ref = "forged";
    },
    (p) => {
      p.head.sha = "b".repeat(40);
    },
    (p) => {
      p.state = "closed";
    },
    (p) => {
      p.labels = [];
    },
    (p) => {
      p.head.repo.private = true;
    },
  ]) {
    const changed = structuredClone(pr);
    mutate(changed);
    assert.throws(() => assertReleasePr(changed, identity, sha));
  }
  const event = { repository: repo, pull_request: pr };
  assert.equal(
    await authorizeReleasePr(event, env, async (url) => {
      assert.equal(url, "/repos/iExalt/paseo/pulls/7");
      return pr;
    }),
    sha,
  );
  await assert.rejects(authorizeReleasePr(event, env, async () => ({ ...pr, number: 8 })));
  assert.throws(() => releaseBotIdentity({ ...env, PASEO_RELEASE_BOT_ID: "9007199254740993" }));
});

test("App JWT, installation identity, permissions and token repository scope are verified", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = { id: 123, client_id: identity.clientId, slug: "paseo-release" };
  const installation = {
    id: 789,
    app_id: 123,
    account: { id: 7889894 },
    repository_selection: "selected",
    permissions: { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
  };
  const request = async (url, token) => {
    if (url.startsWith("/users/")) return pr.user;
    const [header, body, signature] = token.split(".");
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${body}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    );
    const payload = JSON.parse(Buffer.from(body, "base64url"));
    assert.equal(payload.iss, identity.clientId);
    assert.equal(payload.exp - payload.iat, 600);
    return url === "/app" ? app : installation;
  };
  assert.deepEqual(await verifyReleaseApp(identity, privateKey, request), {
    installationId: 789,
    slug: "paseo-release",
  });
  installation.permissions.actions = "write";
  await assert.rejects(verifyReleaseApp(identity, privateKey, request));
  delete installation.permissions.actions;
  app.id++;
  await assert.rejects(verifyReleaseApp(identity, privateKey, request));
  await verifyInstallationToken("fixture", async () => ({ total_count: 1, repositories: [repo] }));
  for (const result of [
    { total_count: 2, repositories: [repo, repo] },
    { total_count: 1, repositories: [{ ...repo, id: 1 }] },
  ]) {
    await assert.rejects(verifyInstallationToken("fixture", async () => result));
  }
});
