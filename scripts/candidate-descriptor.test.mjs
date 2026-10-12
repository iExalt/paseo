import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { candidateGithub } from "../.github/scripts/candidate-github.mjs";
import {
  descriptorFromProof,
  descriptorBytes,
  descriptorDigest,
  draftTag,
  signDescriptor,
  verifyDescriptor,
} from "../.github/scripts/candidate-descriptor.mjs";
import {
  draftBody,
  ensureDraft,
  uploadAttemptBytes,
  loadDescriptor,
} from "../.github/scripts/candidate-draft.mjs";

test("GitHub draft adapter bounds downloads and never forwards authorization to asset storage", async () => {
  const requests = [];
  const bytes = Buffer.from("signed receipt");
  const api = candidateGithub("test-token", async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/releases/assets/"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/receipt" },
      });
    return new Response(bytes);
  });
  assert.deepEqual(await api.read({ id: 7, size: bytes.length }, 100), bytes);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.headers.Accept, "application/octet-stream");
  await assert.rejects(api.read({ id: 7, size: bytes.length }, 2));
  await assert.rejects(api.create({ draft: false }));
  await assert.rejects(api.create({ draft: true, prerelease: false, tag_name: "paseo-v0.1.0" }));
  const hostile = candidateGithub(
    "test-token",
    async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/receipt" } }),
  );
  await assert.rejects(hostile.read({ id: 7, size: bytes.length }, 100));
  const oversized = candidateGithub("test-token", async () => new Response(Buffer.alloc(101)));
  await assert.rejects(oversized.read({ id: 7, size: 100 }, 100));
});

function candidateFixture() {
  return descriptorFromProof(
    {
      number: 7,
      sourceSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      proofs: [
        { workflow: "ci.yml", runId: 100, attempt: 1 },
        { workflow: "ci-deep.yml", runId: 101, attempt: 1 },
      ],
    },
    {
      schemaVersion: 1,
      repository: "iExalt/paseo",
      lineage: "iExalt/paseo:semver-v1",
      version: "0.1.0",
      upstreamBase: "e".repeat(40),
    },
    { version: 1, sourceSha: "a".repeat(40), sha256: "f".repeat(64) },
  );
}

test("candidate authority binds complete immutable identity and separates its signing domain", () => {
  const value = candidateFixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pin = publicKey.export({ format: "jwk" }).x;
  const bytes = descriptorBytes(value),
    signature = signDescriptor(value, pem, pin);
  assert.deepEqual(verifyDescriptor(bytes, signature, pin), value);
  assert.ok(descriptorBytes(Object.fromEntries(Object.entries(value).toReversed())).equals(bytes));
  assert.equal(draftTag(value), `paseo-candidate-v0.1.0-${value.sourceSha}`);
  assert.notEqual(
    descriptorDigest(value),
    descriptorDigest({ ...value, sourceSha: "f".repeat(40) }),
  );
  assert.throws(() => verifyDescriptor(Buffer.concat([bytes, Buffer.from(" ")]), signature, pin));
  assert.throws(() =>
    verifyDescriptor(bytes, sign(null, bytes, privateKey).toString("base64url"), pin),
  );
  assert.throws(() =>
    signDescriptor(
      value,
      pem,
      generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x,
    ),
  );
  for (const override of [
    { releaseTag: "v0.1.0" },
    { repository: "getpaseo/paseo" },
    { sourceSha: "dev" },
    { cells: value.cells.slice(1) },
    { cells: [...value.cells, value.cells[0]] },
    { cells: value.cells.toReversed() },
    { version: "0.1.1" },
    { releasePr: 0 },
    { checks: value.checks.slice(1) },
    { attempt: 2 },
    { keyId: "unknown" },
    { policy: { ...value.policy, version: 2 } },
  ]) {
    assert.throws(() => descriptorBytes({ ...value, ...override }));
  }
});

test("draft transport reconciles interrupted immutable uploads and rejects changed authority", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPin = publicKey.export({ format: "jwk" }).x;
  const descriptor = candidateFixture();
  const signature = signDescriptor(descriptor, pem, publicPin);
  let releases = [],
    nextId = 1,
    lostResponse = true,
    finalTag = null,
    transportTag = null;
  const data = new Map();
  const api = {
    publicPin,
    ref: async (tag) => (tag === descriptor.releaseTag ? finalTag : transportTag),
    list: async () => structuredClone(releases),
    get: async (id) => structuredClone(releases.find((item) => item.id === id)),
    create: async (value) => {
      releases.push({ ...value, id: nextId++, assets: [] });
    },
    read: async (asset, maximum) => {
      const bytes = data.get(asset.id);
      assert.ok(bytes.length <= maximum);
      return bytes;
    },
    upload: async (id, name, bytes) => {
      const asset = { id: nextId++, name, size: bytes.length, state: "uploaded" };
      releases.find((item) => item.id === id).assets.push(asset);
      data.set(asset.id, Buffer.from(bytes));
      if (lostResponse) {
        lostResponse = false;
        throw new Error("Lost response after upload");
      }
    },
  };
  const id = await ensureDraft(api, descriptor, signature);
  assert.equal(await ensureDraft(api, descriptor, signature), id);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].assets.length, 2);
  assert.deepEqual(await loadDescriptor(api, id), descriptor);
  const bytes = Buffer.from("runtime receipt");
  const first = await uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes);
  assert.equal(
    (await uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes)).id,
    first.id,
  );
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", Buffer.from("changed receipt")),
  );
  assert.notEqual(
    (await uploadAttemptBytes(api, descriptor, id, 123, 2, "proof.json", bytes)).id,
    first.id,
  );
  const saved = structuredClone(releases);
  for (const change of [
    (release) => {
      release.draft = false;
    },
    (release) => {
      release.target_commitish = "f".repeat(40);
    },
    (release) => {
      release.body = draftBody(descriptor, "stopped");
    },
    (release) => {
      release.assets.push(release.assets[0]);
    },
    (release) => {
      release.body = draftBody({ ...descriptor, sourceSha: "f".repeat(40) });
    },
  ]) {
    releases = structuredClone(saved);
    change(releases[0]);
    await assert.rejects(uploadAttemptBytes(api, descriptor, id, 123, 3, "proof.json", bytes));
  }
  releases = structuredClone(saved);
  finalTag = { sha: descriptor.sourceSha };
  await assert.rejects(ensureDraft(api, descriptor, signature));
  finalTag = null;
  transportTag = { sha: "9".repeat(40) };
  await assert.rejects(ensureDraft(api, descriptor, signature), /Transport tag already exists/);
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 3, "proof.json", bytes),
    /Transport tag already exists/,
  );
  transportTag = null;
  releases.push({ tag_name: "paseo-v0.1.1" });
  await assert.rejects(ensureDraft(api, descriptor, signature));
  releases = structuredClone(saved);
  const replacement = { ...descriptor, sourceSha: "f".repeat(40) };
  const replacementSignature = signDescriptor(replacement, pem, publicPin);
  await assert.rejects(ensureDraft(api, replacement, replacementSignature));
  releases[0].body = draftBody(descriptor, "stopped");
  const replacementId = await ensureDraft(api, replacement, replacementSignature);
  assert.notEqual(replacementId, id);
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, replacementId, 123, 3, "proof.json", bytes),
  );
});
