import assert from "node:assert/strict";
import { packageLimit, fileIdentity, verifyStream, withVerifiedFile } from "./candidate-files.mjs";

const root = "https://api.github.com/repos/iExalt/paseo";
const uploads = "https://uploads.github.com/repos/iExalt/paseo";
const metadataLimit = 1024 * 1024;
function id(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
  return value;
}
async function bounded(response, maximum) {
  assert.ok(response.body, "Missing response body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= maximum, "GitHub response exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// This adapter has no publication, tag-write, delete or overwrite operation.
// Metadata is bounded in memory; package transfers hash streams end to end.
export function candidateGithub(token, request = fetch) {
  assert.ok(typeof token === "string" && token.length > 0);
  async function response(url, { method = "GET", body, binary = false } = {}) {
    return request(url, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body
          ? { "Content-Type": binary ? "application/octet-stream" : "application/json" }
          : {}),
      },
    });
  }
  async function json(route, options, allowMissing = false) {
    const result = await response(`${root}/${route}`, options);
    if (allowMissing && result.status === 404) return null;
    assert.ok(result.ok, `GitHub metadata request failed (${result.status})`);
    return JSON.parse((await bounded(result, 8 * metadataLimit)).toString("utf8"));
  }
  async function download(asset, maximum, timeout = 30000) {
    id(asset.id);
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= packageLimit);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maximum);
    let url = `${root}/releases/assets/${asset.id}`;
    const signal = AbortSignal.timeout(timeout);
    for (let redirect = 0; redirect <= 3; redirect++) {
      const result = await request(url, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/octet-stream",
          ...(redirect === 0 ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const target = new URL(result.headers.get("location"));
        assert.equal(target.protocol, "https:");
        assert.equal(target.username, "");
        assert.equal(target.password, "");
        assert.ok(
          ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
            target.hostname,
          ),
        );
        await result.body?.cancel();
        url = target.href;
        continue;
      }
      assert.equal(result.status, 200, `GitHub asset download failed (${result.status})`);
      assert.ok(result.body);
      return result;
    }
    throw new Error("Too many asset redirects");
  }
  return {
    async list() {
      const releases = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await json(`releases?per_page=100&page=${page}`);
        assert.ok(Array.isArray(rows));
        releases.push(...rows);
        if (rows.length < 100) return releases;
      }
      throw new Error("Release inventory exceeds bounded pagination");
    },
    get: (releaseId) => json(`releases/${id(releaseId)}`),
    ref: (tag) => json(`git/ref/tags/${encodeURIComponent(tag)}`, undefined, true),
    async setBody(releaseId, body) {
      const control = JSON.parse(body);
      assert.equal(control.kind, "paseo-candidate-storage");
      assert.equal(control.schemaVersion, 1);
      return json(`releases/${id(releaseId)}`, { method: "PATCH", body: JSON.stringify({ body }) });
    },
    async create(value) {
      assert.equal(value.draft, true);
      assert.equal(value.prerelease, false);
      assert.match(value.tag_name, /^paseo-candidate-v\d+\.\d+\.\d+-[a-f0-9]{40}$/);
      assert.match(value.target_commitish, /^[a-f0-9]{40}$/);
      return json("releases", { method: "POST", body: JSON.stringify(value) });
    },
    async upload(releaseId, name, bytes) {
      assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= metadataLimit);
      const result = await response(
        `${uploads}/releases/${id(releaseId)}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", body: bytes, binary: true },
      );
      assert.equal(result.status, 201, `GitHub asset upload failed (${result.status})`);
      return JSON.parse((await bounded(result, metadataLimit)).toString("utf8"));
    },
    async read(asset, maximum) {
      assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= metadataLimit);
      const bytes = await bounded(await download(asset, maximum), maximum);
      assert.equal(bytes.length, asset.size);
      return bytes;
    },
    async verifyFile(asset, expected) {
      fileIdentity(expected);
      assert.equal(asset.size, expected.bytes);
      await verifyStream((await download(asset, expected.bytes, 300000)).body, expected);
    },
    async uploadFile(releaseId, name, file, expected) {
      return withVerifiedFile(file, expected, async (body) => {
        const result = await request(
          `${uploads}/releases/${id(releaseId)}/assets?name=${encodeURIComponent(name)}`,
          {
            method: "POST",
            body,
            duplex: "half",
            redirect: "manual",
            signal: AbortSignal.timeout(300000),
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/octet-stream",
              "Content-Length": String(expected.bytes),
            },
          },
        );
        assert.equal(result.status, 201, `GitHub package upload failed (${result.status})`);
        return JSON.parse((await bounded(result, metadataLimit)).toString("utf8"));
      });
    },
  };
}
