import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_REPOSITORY_ID = 1404390841;
export const RELEASE_REPOSITORY = "iExalt/paseo";

export async function githubRequest(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  // Never include response bodies, authorization headers or key material in errors.
  assert.ok(response.ok, `GitHub request ${path} failed (${response.status})`);
  return response.json();
}

export function releaseBotIdentity(env) {
  for (const name of ["PASEO_RELEASE_APP_ID", "PASEO_RELEASE_BOT_ID"])
    assert.match(env[name] ?? "", /^[1-9][0-9]*$/, `Configure ${name}`);
  for (const name of ["PASEO_RELEASE_APP_ID", "PASEO_RELEASE_BOT_ID"])
    assert.ok(Number.isSafeInteger(Number(env[name])), `Invalid ${name}`);
  assert.match(
    env.PASEO_RELEASE_APP_CLIENT_ID ?? "",
    /^Iv[0-9A-Za-z.]+$/,
    "Configure PASEO_RELEASE_APP_CLIENT_ID",
  );
  assert.match(
    env.PASEO_RELEASE_BOT_LOGIN ?? "",
    /^[a-z0-9-]+\[bot\]$/,
    "Configure PASEO_RELEASE_BOT_LOGIN",
  );
  return {
    appId: Number(env.PASEO_RELEASE_APP_ID),
    clientId: env.PASEO_RELEASE_APP_CLIENT_ID,
    botId: Number(env.PASEO_RELEASE_BOT_ID),
    botLogin: env.PASEO_RELEASE_BOT_LOGIN,
  };
}

export async function verifyReleaseApp(identity, privateKey, request = githubRequest) {
  assert.ok(privateKey, "Configure PASEO_RELEASE_APP_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: identity.clientId })}`;
  const signature = createSign("RSA-SHA256").update(payload).sign(privateKey, "base64url");
  const token = `${payload}.${signature}`;
  const app = await request("/app", token);
  assert.equal(app.id, identity.appId, "App ID mismatch");
  assert.equal(app.client_id, identity.clientId, "App client ID mismatch");
  assert.equal(`${app.slug}[bot]`, identity.botLogin, "App bot login mismatch");
  const installation = await request(`/repos/${RELEASE_REPOSITORY}/installation`, token);
  assert.equal(installation.app_id, identity.appId);
  assert.equal(installation.account.id, 7889894);
  assert.equal(
    installation.repository_selection,
    "selected",
    "Install only on selected repositories",
  );
  assert.deepEqual(
    installation.permissions,
    { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
    "App installation permissions must match the reviewed scope",
  );
  const bot = await request(`/users/${encodeURIComponent(identity.botLogin)}`);
  assert.equal(bot.id, identity.botId, "App bot numeric ID mismatch");
  assert.equal(bot.login, identity.botLogin);
  assert.equal(bot.type, "Bot");
  return { installationId: installation.id, slug: app.slug };
}

export async function verifyInstallationToken(token, request = githubRequest) {
  const repos = await request("/installation/repositories", token);
  assert.equal(repos.total_count, 1, "Token must be scoped to exactly one repository");
  assert.equal(repos.repositories.length, 1);
  assert.equal(repos.repositories[0].id, RELEASE_REPOSITORY_ID);
  assert.equal(repos.repositories[0].full_name, RELEASE_REPOSITORY);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "app") {
    const result = await verifyReleaseApp(
      releaseBotIdentity(process.env),
      process.env.PASEO_RELEASE_APP_PRIVATE_KEY,
    );
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `installation_id=${result.installationId}\nslug=${result.slug}\n`,
    );
  } else if (process.argv[2] === "token") {
    assert.equal(process.env.TOKEN_INSTALLATION_ID, process.env.VERIFIED_INSTALLATION_ID);
    assert.equal(process.env.TOKEN_APP_SLUG, process.env.VERIFIED_APP_SLUG);
    await verifyInstallationToken(process.env.RELEASE_APP_TOKEN);
  } else throw new Error("Expected app or token verification mode");
}
