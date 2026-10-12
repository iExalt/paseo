import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateGithub } from "../.github/scripts/candidate-github.mjs";
import { exportProducts, productFiles } from "../.github/scripts/candidate-product-export.mjs";
import { verifyStream, withVerifiedFile } from "../.github/scripts/candidate-files.mjs";
import {
  aggregateCandidate,
  producerGroups,
  verificationJobs,
} from "../.github/scripts/candidate-matrix.mjs";
import { forkReleaseManifestFixture } from "./test-fixtures/fork-release-manifest.ts";
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

test("native exports copy only exact candidate bytes into fresh canonical bundles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-export-"));
  const descriptor = candidateFixture();
  const bytes = Buffer.from("native package fixture");
  const identity = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "2",
    PASEO_CANDIDATE_SHA: descriptor.sourceSha,
    CANDIDATE_DESCRIPTOR_DIGEST: descriptorDigest(descriptor),
    CANDIDATE_CONTEXT: join(directory, "context.json"),
    GITHUB_OUTPUT: join(directory, "output"),
    EXPECTED_ARCHITECTURE: "arm64",
  };
  try {
    await writeFile(env.CANDIDATE_CONTEXT, JSON.stringify({ descriptor, runId: 500, attempt: 2 }));
    for (const platform of ["linux", "windows"]) {
      const root = join(
        directory,
        `${platform === "linux" ? "paseo-products" : "paseo-windows-products"}-500-2`,
      );
      const metadata = {
        sourceSha: descriptor.sourceSha,
        version: descriptor.version,
        architecture: "arm64",
        artifacts: Object.fromEntries(
          ["deb", "rpm", "appimage"].map((kind) => [
            kind,
            { ...identity, file: `candidate-arm64.${kind === "appimage" ? "AppImage" : kind}` },
          ]),
        ),
        installer: { ...identity, filename: "/untrusted/ignored" },
      };
      const files = productFiles(metadata, descriptor, platform, "arm64");
      await mkdir(join(root, "packages/candidate"), { recursive: true });
      for (const file of files) await writeFile(join(root, "packages", file.relative), bytes);
      await writeFile(join(root, "candidate.json"), JSON.stringify(metadata));
      await exportProducts(env, platform);
      const bundle = JSON.parse(
        await readFile(join(root, "candidate-export/candidate-products.json")),
      );
      assert.equal(bundle.descriptorSha256, descriptorDigest(descriptor));
      assert.equal(bundle.runtime, undefined);
      for (const file of files)
        assert.deepEqual(await readFile(join(root, "candidate-export", file.artifact.name)), bytes);
      await assert.rejects(exportProducts(env, platform), /EEXIST/);
      assert.throws(() =>
        productFiles({ ...metadata, sourceSha: "b".repeat(40) }, descriptor, platform, "arm64"),
      );
      await rm(join(root, "candidate-export"), { recursive: true });
      await writeFile(join(root, "packages", files[0].relative), "wrong bytes");
      await assert.rejects(exportProducts(env, platform));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("package transfer streams verified files and rejects truncation, mutation and early replies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-stream-"));
  const file = join(directory, "package.bin");
  const bytes = Buffer.alloc(1024 * 128, 42);
  const expected = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    await writeFile(file, bytes);
    const api = candidateGithub("test-token", async (_url, options) => {
      if (options.method === "POST") {
        assert.equal(options.duplex, "half");
        assert.equal(options.headers["Content-Length"], String(bytes.length));
        await verifyStream(options.body, expected);
        return Response.json({ id: 1, size: bytes.length }, { status: 201 });
      }
      return new Response(bytes);
    });
    const asset = await api.uploadFile(42, "package.bin", file, expected);
    await api.verifyFile(asset, expected);
    await assert.rejects(verifyStream([bytes.subarray(1)], expected), /Truncated/);
    await assert.rejects(verifyStream([bytes, Buffer.from("x")], expected), /exceeds/);
    await assert.rejects(
      withVerifiedFile(file, expected, async () => {}),
      /did not consume/,
    );
    await assert.rejects(
      withVerifiedFile(file, expected, async (body) => {
        await writeFile(file, Buffer.alloc(bytes.length, 43));
        for await (const chunk of body) assert.ok(chunk.length);
      }),
    );
    const linked = join(directory, "linked.bin");
    await symlink(file, linked);
    await assert.rejects(
      withVerifiedFile(linked, expected, async () => {}),
      /regular file/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate aggregate requires every same-attempt native cell and all source verification lanes", () => {
  const descriptor = candidateFixture();
  const jobs = Object.entries(producerGroups).map(([, group], index) => ({
    id: index + 1,
    name: group.job,
    status: "completed",
    conclusion: "success",
  }));
  jobs.push(
    ...verificationJobs.map((name, index) => ({
      id: 100 + index,
      name,
      status: "completed",
      conclusion: "success",
    })),
  );
  const receipts = forkReleaseManifestFixture().artifacts.map((artifact) => {
    const cell = `${artifact.platform}/${artifact.arch}/${artifact.kind}`;
    const [group, producer] = Object.entries(producerGroups).find(([, item]) =>
      item.cells.includes(cell),
    );
    let signature = "not-applicable";
    if (artifact.kind.startsWith("nix-")) signature = "nix-pinned";
    if (artifact.kind === "apk") signature = "android-pinned";
    return {
      schemaVersion: 1,
      kind: "paseo-candidate-cell",
      descriptorSha256: descriptorDigest(descriptor),
      sourceSha: descriptor.sourceSha,
      treeSha: descriptor.treeSha,
      version: descriptor.version,
      runId: 500,
      attempt: 2,
      group,
      producerJobId: jobs.find((job) => job.name === producer.job).id,
      cell,
      artifact,
      runtime: { passed: true, cleanup: true, signature },
    };
  });
  assert.equal(aggregateCandidate(descriptor, 500, 2, receipts, jobs).artifacts.length, 14);
  for (const change of [
    (rows) => rows.pop(),
    (rows) => rows.push(rows[0]),
    (rows) => {
      rows[1] = rows[0];
    },
    (rows) => {
      rows[0].attempt = 1;
    },
    (rows) => {
      rows[0].sourceSha = "f".repeat(40);
    },
    (rows) => {
      rows[0].runtime.passed = false;
    },
    (rows) => {
      rows[0].runtime.cleanup = false;
    },
    (rows) => {
      rows[0].runtime.signature = "not-applicable";
    },
    (rows) => {
      rows[0].producerJobId = 999;
    },
    (rows) => {
      rows[0].artifact.bytes = 0;
    },
    (rows) => {
      rows[0].artifact.sha256 = "bad";
    },
    (rows) => {
      rows[0].artifact.closureManifest = rows[1].artifact.closureManifest;
    },
  ]) {
    const altered = structuredClone(receipts);
    change(altered);
    assert.throws(() => aggregateCandidate(descriptor, 500, 2, altered, jobs));
  }
  for (const name of [producerGroups[receipts[0].group].job, verificationJobs[0]]) {
    assert.throws(() =>
      aggregateCandidate(
        descriptor,
        500,
        2,
        receipts,
        jobs.filter((job) => job.name !== name),
      ),
    );
    assert.throws(() =>
      aggregateCandidate(
        descriptor,
        500,
        2,
        receipts,
        jobs.map((job) =>
          job.name === name ? Object.assign({}, job, { conclusion: "failure" }) : job,
        ),
      ),
    );
  }
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
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes),
    /no longer admitted/,
  );
  releases[0].body = draftBody(descriptor, "active", { runId: 123, attempt: 1 });
  const first = await uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes);
  assert.equal(
    (await uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes)).id,
    first.id,
  );
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", Buffer.from("changed receipt")),
  );
  releases[0].body = draftBody(descriptor, "active", { runId: 123, attempt: 2 });
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 1, "proof.json", bytes),
    /no longer admitted/,
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
    await assert.rejects(uploadAttemptBytes(api, descriptor, id, 123, 2, "proof.json", bytes));
  }
  releases = structuredClone(saved);
  finalTag = { sha: descriptor.sourceSha };
  await assert.rejects(ensureDraft(api, descriptor, signature));
  finalTag = null;
  transportTag = { sha: "9".repeat(40) };
  await assert.rejects(ensureDraft(api, descriptor, signature), /Transport tag already exists/);
  await assert.rejects(
    uploadAttemptBytes(api, descriptor, id, 123, 2, "proof.json", bytes),
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
