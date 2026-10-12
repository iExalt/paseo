import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateGithub } from "../.github/scripts/candidate-github.mjs";
import { exportProducts, productFiles } from "../.github/scripts/candidate-product-export.mjs";
import {
  productProducer,
  productReceipts,
  transferProducts,
} from "../.github/scripts/candidate-product-transfer.mjs";
import { verifyAggregate, signAggregate } from "../.github/scripts/candidate-aggregate.mjs";
import { pairedRuntime, transferPaired } from "../.github/scripts/candidate-paired-transfer.mjs";
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

for (const group of ["windows-arm64", "linux-nix-arm64"])
  test(`trusted ${group} transfer admits exact bytes only after completed provenance`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "candidate-transfer-"));
    const descriptor = candidateFixture();
    const context = {
      descriptor,
      releaseId: 42,
      runId: 500,
      attempt: 2,
      controllerSha: "c".repeat(40),
    };
    const nix = group.startsWith("linux-nix-");
    const bytes = Buffer.from("native installer fixture");
    const payload = {
      platform: "windows",
      arch: "arm64",
      kind: "nsis",
      name: "paseo-0.1.0-windows-arm64.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const hash = (value) => ({
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
    const manifests = new Map();
    const manifestBytes = new Map();
    const artifacts = nix
      ? ["daemon", "desktop"].map((product) => {
          const name = `paseo-0.1.0-linux-arm64-nix-${product}.tar`;
          const outputPath = `/nix/store/${"a".repeat(32)}-${product === "desktop" ? "paseo-desktop" : "paseo"}-0.1.0`;
          const manifest = {
            schemaVersion: 1,
            kind: "paseo-nix-closure",
            sourceSha: descriptor.sourceSha,
            treeSha: descriptor.treeSha,
            version: descriptor.version,
            system: "aarch64-linux",
            product,
            outputPath,
            closure: [
              { path: outputPath, narHash: "sha256-" + "a".repeat(43) + "=", narSize: 4096 },
            ],
          };
          const manifestName = name.replace(/\.tar$/, ".json");
          const value = Buffer.from(JSON.stringify(manifest) + "\n");
          manifests.set(manifestName, manifest);
          manifestBytes.set(manifestName, value);
          return {
            platform: "linux",
            arch: "arm64",
            kind: `nix-${product}`,
            name,
            bytes: bytes.length,
            sha256: hash(bytes).sha256,
            system: "aarch64-linux",
            outputPath,
            manifestPath: `/nix/store/${"b".repeat(32)}-${manifestName}`,
            closureManifest: Object.assign({ name: manifestName }, hash(value)),
          };
        })
      : [payload];
    const bundle = {
      schemaVersion: 1,
      kind: nix ? "paseo-candidate-nix" : "paseo-candidate-products",
      descriptorSha256: descriptorDigest(descriptor),
      sourceSha: descriptor.sourceSha,
      treeSha: descriptor.treeSha,
      version: descriptor.version,
      runId: 500,
      attempt: 2,
      group,
      artifacts,
    };
    const stamp = "2026-10-12T12:00:00Z";
    const job = {
      id: 123,
      run_id: 500,
      run_attempt: 2,
      name: producerGroups[group].job,
      status: "completed",
      conclusion: "success",
      started_at: stamp,
      completed_at: stamp,
      steps: (nix
        ? [
            "Authenticate candidate and admitted attempt",
            "Read authenticated candidate source",
            "Replace owned Nix profile and verify retained desktop state",
            "Export and verify signed native closures",
            "Remove owned temporary Nix signing key",
            "Transfer immutable candidate closures",
          ]
        : [
            "Authenticate candidate and admitted attempt",
            "Read authenticated candidate source",
            "Verify installed upgrade, retained CLI, PTY and real speech",
            "Reconcile owned processes and remove installation and state",
            "Export verified candidate packages",
            "Transfer immutable candidate packages",
          ]
      ).map((name, index) => ({
        name,
        number: index + 1,
        status: "completed",
        conclusion: "success",
        started_at: stamp,
        completed_at: stamp,
      })),
    };
    const env = {
      RUNNER_TEMP: directory,
      GH_TOKEN: "fixture",
      GITHUB_RUN_ID: "500",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: context.controllerSha,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      CANDIDATE_PRODUCT_GROUP: group,
      CANDIDATE_ARTIFACT_ID: "77",
    };
    try {
      await mkdir(join(directory, "input"));
      for (const item of artifacts) await writeFile(join(directory, "input", item.name), bytes);
      for (const [name, value] of manifestBytes)
        await writeFile(join(directory, "input", name), value);
      await writeFile(
        join(directory, "input", nix ? "candidate-nix.json" : "candidate-products.json"),
        JSON.stringify(bundle),
      );
      execFileSync("python3", [
        "-c",
        "import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for p in pathlib.Path(sys.argv[1]).iterdir(): z.write(p,p.name)",
        join(directory, "input"),
        join(directory, "fixture.zip"),
      ]);
      const zip = await readFile(join(directory, "fixture.zip"));
      env.CANDIDATE_ARTIFACT_DIGEST = createHash("sha256").update(zip).digest("hex");
      const artifact = {
        id: 77,
        name: nix ? "candidate-linux-nix-arm64-500-2" : "candidate-windows-products-arm64-500-2",
        digest: `sha256:${env.CANDIDATE_ARTIFACT_DIGEST}`,
        expired: false,
        size_in_bytes: zip.length,
        created_at: stamp,
        workflow_run: {
          id: 500,
          head_sha: context.controllerSha,
          head_branch: "dev",
          repository_id: 1404390841,
          head_repository_id: 1404390841,
        },
      };
      const expected = { id: 77, digest: env.CANDIDATE_ARTIFACT_DIGEST };
      assert.equal(productProducer(context, group, [job], artifact, expected), 123);
      for (const patch of [
        { run_attempt: 1 },
        { conclusion: "failure" },
        {
          steps: job.steps.map((step, index) =>
            index === 3 ? { ...step, conclusion: "skipped" } : step,
          ),
        },
        { steps: [...job.steps, job.steps[0]] },
        { steps: job.steps.map((step, index) => (index === 4 ? { ...step, number: 2 } : step)) },
      ])
        assert.throws(() =>
          productProducer(context, group, [{ ...job, ...patch }], artifact, expected),
        );
      assert.throws(() =>
        productProducer(
          context,
          group,
          [job],
          {
            ...artifact,
            workflow_run: { ...artifact.workflow_run, head_sha: descriptor.sourceSha },
          },
          expected,
        ),
      );
      assert.throws(() => productReceipts({ ...bundle, attempt: 1 }, context, group, 123));
      assert.throws(() =>
        productReceipts(
          { ...bundle, artifacts: [{ ...payload, name: "../escape" }] },
          context,
          group,
          123,
        ),
      );
      if (nix) {
        const wrong = structuredClone(manifests);
        wrong.values().next().value.sourceSha = "f".repeat(40);
        assert.throws(() => productReceipts(bundle, context, group, 123, wrong));
        const incomplete = structuredClone(job);
        incomplete.steps[4].conclusion = "skipped";
        assert.throws(() => productProducer(context, group, [incomplete], artifact, expected));
      }
      const pair = generateKeyPairSync("ed25519");
      const pin = pair.publicKey.export({ format: "jwk" }).x;
      const signature = signDescriptor(
        descriptor,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
        pin,
      );
      const draft = {
        id: 42,
        draft: true,
        prerelease: false,
        name: draftTag(descriptor),
        tag_name: draftTag(descriptor),
        target_commitish: descriptor.sourceSha,
        body: draftBody(descriptor, "active", { runId: 500, attempt: 2 }),
        assets: [],
      };
      const data = new Map();
      function upload(_id, name, value) {
        const asset = { id: data.size + 1, name, size: value.length, state: "uploaded" };
        data.set(asset.id, value);
        draft.assets.push(asset);
        return asset;
      }
      upload(42, "candidate-descriptor.json", descriptorBytes(descriptor));
      upload(42, "candidate-descriptor.sig", Buffer.from(signature));
      const api = {
        publicPin: pin,
        get: async () => structuredClone(draft),
        list: async () => [structuredClone(draft)],
        ref: async () => null,
        read: async (asset) => data.get(asset.id),
        upload,
        uploadFile: async (id, name, file, identity) => {
          const value = await readFile(file);
          await verifyStream([value], identity);
          return upload(id, name, value);
        },
        verifyFile: async (asset, identity) => verifyStream([data.get(asset.id)], identity),
      };
      const root = {
        id: 500,
        run_attempt: 2,
        repository: { id: 1404390841, full_name: "iExalt/paseo", private: false },
        path: ".github/workflows/release-candidate.yml",
        head_sha: context.controllerSha,
        head_branch: "dev",
        event: "workflow_dispatch",
        status: "in_progress",
        conclusion: null,
        actor: { id: 7889894, login: "iExalt" },
      };
      await transferProducts(env, {
        authenticate: async () => context,
        draftApi: () => api,
        response: async () => new Response(zip),
        request: async (route) => {
          if (route.includes("/jobs?")) return { jobs: [job] };
          if (route.includes("/artifacts/")) return artifact;
          return root;
        },
      });
      const receipt = draft.assets.find((asset) => asset.name.endsWith(`receipts-${group}.json`));
      assert.deepEqual(
        JSON.parse(data.get(receipt.id)),
        productReceipts(bundle, context, group, 123, manifests),
      );
      assert.deepEqual(
        data.get(draft.assets.find((asset) => asset.name.endsWith(artifacts[0].name)).id),
        bytes,
      );
      for (const [name, value] of manifestBytes) {
        assert.deepEqual(
          data.get(draft.assets.find((asset) => asset.name.endsWith(name)).id),
          value,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("paired transfer binds signing, fresh import and native runtime before retaining original bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-transfer-"));
  const descriptor = candidateFixture();
  const context = {
    descriptor,
    releaseId: 42,
    runId: 500,
    attempt: 2,
    controllerSha: "c".repeat(40),
  };
  const pin = {
    runId: "500",
    attempt: "2",
    sourceSha: descriptor.sourceSha,
    version: descriptor.version,
  };
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const payload = Buffer.from("already signed native bytes");
  const cert = "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459";
  const outputPath = `/nix/store/${"a".repeat(32)}-paseo-desktop-0.1.0`;
  const closure = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      kind: "paseo-verification-candidate",
      platform: "macos-arm64",
      sourceSha: pin.sourceSha,
      forkVersion: pin.version,
      packageVersion: pin.version,
      system: "aarch64-darwin",
      outputPath,
      lockHash: "b".repeat(64),
      provenance: "local-ci-build",
      closure: [{ path: outputPath, narHash: "sha256-" + "a".repeat(43) + "=", narSize: 4096 }],
    }) + "\n",
  );
  const android = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      kind: "paseo-verification-candidate",
      platform: "android-arm64",
      sourceSha: pin.sourceSha,
      forkVersion: pin.version,
      versionCode: "201000",
      packageId: "sh.paseo.iexalt",
      abi: "arm64-v8a",
      runId: "500",
      runAttempt: "2",
      signingRunId: "500",
      signingRunAttempt: "2",
      signingCertificateSha256: cert,
      apkSha256: hash(payload),
    }),
  );
  const candidate = {
    schemaVersion: 2,
    kind: "paseo-verification-candidate",
    status: "candidate",
    sourceSha: pin.sourceSha,
    forkVersion: pin.version,
    runId: "500",
    runAttempt: "2",
    android: {
      artifactId: "10",
      artifactDigest: "b".repeat(64),
      artifactRunAttempt: "2",
      artifactName: `paseo-iexalt-201000-${pin.sourceSha}-attempt-2`,
      packageId: "sh.paseo.iexalt",
      versionCode: "201000",
      signingCertificateSha256: cert,
      apkSha256: hash(payload),
      metadataSha256: hash(android),
    },
    macOS: {
      artifactId: "11",
      artifactDigest: "b".repeat(64),
      artifactRunAttempt: "2",
      artifactName: `paseo-nix-closure-${pin.sourceSha}-0.1.0-attempt-2`,
      system: "aarch64-darwin",
      provenance: "local-ci-build",
      nodeSeedProvenance: "local-built-dependency",
      archiveSha256: hash(payload),
      manifestSha256: hash(closure),
      lockHash: "b".repeat(64),
      outputPath,
      manifestPath: `/nix/store/${"b".repeat(32)}-manifest.json`,
    },
  };
  const auth = "Authenticate candidate and admitted attempt",
    stamp = "2026-10-12T12:00:00Z";
  const jobs = [
    [
      "paired / Build and verify macOS closure / Build and sign macOS closure",
      [
        auth,
        "Read authenticated candidate source",
        "Sign and export the closure",
        "Remove temporary Nix signing key file",
        "Upload public closure and metadata artifact",
      ],
    ],
    [
      "paired / Build and verify macOS closure / Verify closure on a fresh runner",
      [auth, "Read authenticated candidate source", "Import and verify signed closure"],
    ],
    [
      "paired / Build and sign Android APK / Sign and publish fork APK artifact",
      [auth, "Sign and verify with the approved fork certificate", "Remove signing material"],
    ],
    [
      "native-runtime / macos",
      [auth, "Verify canonical signed packages and preserved native state"],
    ],
    [
      "native-runtime / android",
      [
        auth,
        "Verify signed ARM64 APKs and retained native state",
        "Remove owned Android container after interruption",
      ],
    ],
  ].map(([name, names], index) => ({
    id: index + 1,
    name,
    run_id: 500,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    started_at: stamp,
    completed_at: stamp,
    steps: names.map((stepName, stepIndex) => ({
      name: stepName,
      number: stepIndex + 1,
      status: "completed",
      conclusion: "success",
      started_at: stamp,
      completed_at: stamp,
    })),
  }));
  const pair = generateKeyPairSync("ed25519"),
    publicPin = pair.publicKey.export({ format: "jwk" }).x;
  const draft = {
    id: 42,
    draft: true,
    prerelease: false,
    name: draftTag(descriptor),
    tag_name: draftTag(descriptor),
    target_commitish: descriptor.sourceSha,
    body: draftBody(descriptor, "active", { runId: 500, attempt: 2 }),
    assets: [],
  };
  const data = new Map();
  function upload(_id, name, value) {
    const asset = { id: data.size + 1, name, size: value.length, state: "uploaded" };
    data.set(asset.id, value);
    draft.assets.push(asset);
    return asset;
  }
  upload(42, "candidate-descriptor.json", descriptorBytes(descriptor));
  upload(
    42,
    "candidate-descriptor.sig",
    Buffer.from(
      signDescriptor(
        descriptor,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
        publicPin,
      ),
    ),
  );
  const api = {
    publicPin,
    get: async () => structuredClone(draft),
    list: async () => [structuredClone(draft)],
    ref: async () => null,
    read: async (asset) => data.get(asset.id),
    upload,
    uploadFile: async (id, name, file, identity) => {
      const value = await readFile(file);
      await verifyStream([value], identity);
      return upload(id, name, value);
    },
    verifyFile: async (asset, identity) => verifyStream([data.get(asset.id)], identity),
  };
  const root = {
    id: 500,
    run_attempt: 2,
    repository: { id: 1404390841, full_name: "iExalt/paseo", private: false },
    path: ".github/workflows/release-candidate.yml",
    head_sha: context.controllerSha,
    head_branch: "dev",
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    actor: { id: 7889894, login: "iExalt" },
  };
  try {
    for (const platform of ["macos", "android"]) {
      const env = {
        RUNNER_TEMP: directory,
        GH_TOKEN: "fixture",
        GITHUB_RUN_ID: "500",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: context.controllerSha,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        CANDIDATE_PLATFORM: platform,
        CANDIDATE_PIN: JSON.stringify(pin),
      };
      const missing = jobs.filter(
        (job) => !job.name.includes(platform === "macos" ? "fresh runner" : "Sign and publish"),
      );
      assert.throws(() => pairedRuntime(context, platform, missing));
      assert.throws(() =>
        pairedRuntime(
          context,
          platform,
          jobs.map((job) => ({ ...job, run_attempt: 1 })),
        ),
      );
      await transferPaired(env, {
        authenticate: async () => context,
        draftApi: () => api,
        request: async (route) => (route.includes("/jobs?") ? { jobs } : root),
        download: async (_pin, destination) => {
          await mkdir(join(destination, platform), { recursive: true });
          await writeFile(
            join(
              destination,
              platform,
              platform === "macos"
                ? `${candidate.macOS.artifactName}.tar`
                : "paseo-iexalt-fork-201000.apk",
            ),
            payload,
          );
          await writeFile(
            join(
              destination,
              platform,
              platform === "macos" ? "manifest.json" : "build-metadata.json",
            ),
            platform === "macos" ? closure : android,
          );
          return candidate;
        },
      });
      const receiptAsset = draft.assets.find((asset) =>
        asset.name.endsWith(`receipts-${platform}-arm64.json`),
      );
      const [receipt] = JSON.parse(data.get(receiptAsset.id));
      assert.equal(
        receipt.runtime.signature,
        platform === "macos" ? "nix-pinned" : "android-pinned",
      );
      assert.deepEqual(
        data.get(draft.assets.find((asset) => asset.name.endsWith(receipt.artifact.name)).id),
        payload,
      );
      if (platform === "macos")
        assert.deepEqual(
          data.get(
            draft.assets.find((asset) => asset.name.endsWith(receipt.artifact.closureManifest.name))
              .id,
          ),
          closure,
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft inventory paginates retries and rejects duplicate or unbounded assets", async () => {
  let count = 101,
    duplicate = false;
  const api = candidateGithub("fixture", async (url) => {
    if (!url.includes("/assets?")) return Response.json({ id: 42, assets: [] });
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(
      Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, index) => {
        const id = duplicate ? 1 : (page - 1) * 100 + index + 1;
        return { id, name: `attempt-asset-${id}` };
      }),
    );
  });
  assert.equal((await api.get(42)).assets.length, 101);
  duplicate = true;
  await assert.rejects(api.get(42), /Duplicate/);
  duplicate = false;
  count = 1000;
  await assert.rejects(api.get(42), /bounded pagination/);
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

test("candidate aggregate requires every same-attempt native cell and all source verification lanes", async () => {
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

  const directory = await mkdtemp(join(tmpdir(), "candidate-aggregate-"));
  const pair = generateKeyPairSync("ed25519"),
    publicPin = pair.publicKey.export({ format: "jwk" }).x;
  const draft = {
    id: 42,
    draft: true,
    prerelease: false,
    name: draftTag(descriptor),
    tag_name: draftTag(descriptor),
    target_commitish: descriptor.sourceSha,
    body: draftBody(descriptor, "active", { runId: 500, attempt: 2 }),
    assets: [],
  };
  const data = new Map();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  function upload(_id, name, value) {
    const asset = { id: data.size + 1, name, size: value.length, state: "uploaded" };
    data.set(asset.id, value);
    draft.assets.push(asset);
    return asset;
  }
  upload(42, "candidate-descriptor.json", descriptorBytes(descriptor));
  upload(
    42,
    "candidate-descriptor.sig",
    Buffer.from(
      signDescriptor(
        descriptor,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
        publicPin,
      ),
    ),
  );
  for (const receipt of receipts) {
    const artifact = receipt.artifact,
      bytes = Buffer.from(artifact.name);
    artifact.bytes = bytes.length;
    artifact.sha256 = hash(bytes);
    upload(42, `run-500-attempt-2-${artifact.name}`, bytes);
    if (artifact.closureManifest) {
      const closure = Buffer.from(
        JSON.stringify({
          schemaVersion: artifact.platform === "macos" ? 2 : 1,
          kind:
            artifact.platform === "macos" ? "paseo-verification-candidate" : "paseo-nix-closure",
          sourceSha: descriptor.sourceSha,
          treeSha: descriptor.treeSha,
          version: descriptor.version,
          forkVersion: descriptor.version,
          system: artifact.system,
          outputPath: artifact.outputPath,
          provenance: "local-ci-build",
          closure: [
            { path: artifact.outputPath, narHash: "sha256-" + "a".repeat(43) + "=", narSize: 4096 },
          ],
        }),
      );
      artifact.closureManifest.bytes = closure.length;
      artifact.closureManifest.sha256 = hash(closure);
      upload(42, `run-500-attempt-2-${artifact.closureManifest.name}`, closure);
    }
  }
  for (const group of Object.keys(producerGroups))
    upload(
      42,
      `run-500-attempt-2-receipts-${group}.json`,
      Buffer.from(JSON.stringify(receipts.filter((receipt) => receipt.group === group))),
    );
  const api = {
    publicPin,
    get: async () => structuredClone(draft),
    list: async () => [structuredClone(draft)],
    ref: async () => null,
    read: async (asset) => data.get(asset.id),
    upload,
    verifyFile: async (asset, identity) => verifyStream([data.get(asset.id)], identity),
  };
  const context = {
    descriptor,
    releaseId: 42,
    runId: 500,
    attempt: 2,
    controllerSha: "c".repeat(40),
  };
  const root = {
    id: 500,
    run_attempt: 2,
    repository: { id: 1404390841, full_name: "iExalt/paseo", private: false },
    path: ".github/workflows/release-candidate.yml",
    head_sha: context.controllerSha,
    head_branch: "dev",
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    actor: { id: 7889894, login: "iExalt" },
  };
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "outputs"),
    GH_TOKEN: "fixture",
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: context.controllerSha,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    CANDIDATE_NATIVE_ENABLED: "true",
  };
  const adapters = {
    authenticate: async () => context,
    draftApi: () => api,
    publicPin,
    request: async (route) =>
      route.includes("/jobs?")
        ? { jobs: jobs.map((job) => ({ ...job, run_id: 500, run_attempt: 2 })) }
        : root,
  };
  try {
    await assert.rejects(
      verifyAggregate({ ...env, CANDIDATE_NATIVE_ENABLED: "false" }, adapters),
      /canary/,
    );
    const complete = await verifyAggregate(env, adapters);
    assert.equal(complete.artifacts.length, 14);
    const verified = Object.fromEntries(
      (await readFile(env.GITHUB_OUTPUT, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const signing = {
      ...env,
      VERIFIED_MANIFEST_DIGEST: verified.manifest_digest,
      VERIFIED_EVIDENCE_DIGEST: verified.evidence_digest,
      PASEO_RELEASE_MANIFEST_PRIVATE_KEY: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
    draft.body = draftBody(descriptor, "active", { runId: 500, attempt: 3 });
    await assert.rejects(signAggregate({ ...signing }, adapters), /no longer admitted/);
    assert.ok(!draft.assets.some((asset) => asset.name.endsWith("paseo-release-manifest.sig")));
    draft.body = draftBody(descriptor, "active", { runId: 500, attempt: 2 });
    await signAggregate(signing, adapters);
    const final = data.get(
      draft.assets.find((asset) => asset.name.endsWith("paseo-release-manifest.json")).id,
    );
    const signature = data.get(
      draft.assets.find((asset) => asset.name.endsWith("paseo-release-manifest.sig")).id,
    );
    assert.equal(
      verify(null, final, pair.publicKey, Buffer.from(signature.toString(), "base64url")),
      true,
    );
    assert.equal(draft.draft, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
