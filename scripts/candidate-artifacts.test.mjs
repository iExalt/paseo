import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { downloadGrant } from "../.github/scripts/candidate-grant.mjs";

test("worker grant transport binds immutable artifact bytes and root provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-grant-"));
  const grant = { context: { rootHeadSha: "a".repeat(40), rootBranch: "dev", attempt: 2 } };
  const zip = execFileSync("python3", [
    "-c",
    "import io,sys,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,'w');z.writestr('grant.json',sys.argv[1]);z.close();sys.stdout.buffer.write(b.getvalue())",
    JSON.stringify(grant),
  ]);
  const digest = createHash("sha256").update(zip).digest("hex");
  const env = {
    RUNNER_TEMP: directory,
    GH_TOKEN: "fixture",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    CANDIDATE_GRANT_ID: "456",
    CANDIDATE_GRANT_DIGEST: digest,
    CANDIDATE_GRANT_GROUP: "verification",
  };
  const metadata = {
    id: 456,
    name: "candidate-grant-verification-123-2",
    digest: `sha256:${digest}`,
    expired: false,
    size_in_bytes: zip.length,
    workflow_run: { id: 123, head_sha: grant.context.rootHeadSha, head_branch: "dev" },
  };
  const request = (value) => async (url) =>
    url.endsWith("/zip") ? new Response(zip) : Response.json(value);
  try {
    assert.deepEqual(await downloadGrant(env, request(metadata)), grant);
    // Execute the real CLI: library imports alone cannot detect a top-level-await
    // cycle. A transported but incomplete authority must reach workerGate and fail.
    const preload = join(directory, "transport.mjs");
    await writeFile(
      preload,
      `
      globalThis.fetch = async (url) => {
        if (url === 'https://api.github.com/repos/iExalt/paseo/actions/artifacts/456')
          return Response.json(${JSON.stringify(metadata)});
        if (url === 'https://api.github.com/repos/iExalt/paseo/actions/artifacts/456/zip') {
          console.log('GRANT_ZIP_REACHED');
          return new Response(Buffer.from('${zip.toString("base64")}', 'base64'));
        }
        throw new Error('Unexpected fixture request: ' + url);
      };
    `,
    );
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const cli = spawnSync(
      process.execPath,
      ["--import", preload, ".github/scripts/candidate-worker.mjs"],
      {
        cwd,
        timeout: 5000,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          GITHUB_SHA: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
          GITHUB_REPOSITORY: "iExalt/paseo",
          GITHUB_REF: "refs/heads/dev",
          GITHUB_WORKFLOW_REF:
            "iExalt/paseo/.github/workflows/release-candidate.yml@refs/heads/dev",
          CANDIDATE_RELEASE_ID: "42",
        },
      },
    );
    assert.equal(cli.error, undefined);
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /GRANT_ZIP_REACHED/);
    assert.match(cli.stderr, /workerGate/);
    assert.doesNotMatch(cli.stderr, /unsettled top-level await/);
    for (const delta of [
      { id: 457 },
      // The issuing attempt in the name must match the grant, and never be later.
      { name: "candidate-grant-verification-123-1" },
      { name: "candidate-grant-verification-123-3" },
      { name: "candidate-grant-verification-123-02" },
      { name: "candidate-grant-paired-identity-123-2" },
      { digest: `sha256:${"f".repeat(64)}` },
      { workflow_run: { ...metadata.workflow_run, id: 124 } },
      { workflow_run: { ...metadata.workflow_run, head_sha: "b".repeat(40) } },
      { workflow_run: { ...metadata.workflow_run, head_branch: "other" } },
    ])
      await assert.rejects(downloadGrant(env, request({ ...metadata, ...delta })));
    await assert.rejects(
      downloadGrant(env, async (url) =>
        url.endsWith("/zip") ? new Response(Buffer.alloc(zip.length)) : Response.json(metadata),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
import {
  fetchCandidate,
  githubResponse,
  saveDownload,
  validateArtifact,
  validateCandidate,
  validateProducer,
  validateCoordinatedProducer,
} from "../.github/scripts/candidate-artifacts.mjs";
import { installStepProofs } from "./step-proof-fixture.mjs";

const sha = "a".repeat(40);
const hash = "b".repeat(64);
const pin = { runId: "123", attempt: "2", sourceSha: sha, version: "0.1.0" };
const run = {
  id: 123,
  run_attempt: 2,
  path: ".github/workflows/fork-builds.yml",
  event: "workflow_dispatch",
  actor: { login: "iExalt" },
  head_branch: "dev",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
};

test("paired runtime distinguishes current coordinator completion from historical manual producers", async (t) => {
  const context = {
    runId: 123,
    attempt: 2,
    controllerSha: "c".repeat(40),
    rootHeadSha: "d".repeat(40),
    rootBranch: "dev",
    descriptor: { sourceSha: sha, version: pin.version },
  };
  const current = {
    ...run,
    path: ".github/workflows/release-candidate.yml",
    head_sha: context.rootHeadSha,
    status: "in_progress",
    conclusion: null,
  };
  const executions = (crossCheck) => ({
    "paired / Cross-check paired candidate artifacts": crossCheck,
    "paired / Build and sign Android APK / Sign and publish fork APK artifact": 1,
    "paired / Build and sign Android APK / Build fork arm64 APK": 1,
    "paired / Build and verify macOS closure / Build and sign macOS closure": crossCheck,
  });
  const ledger = (crossCheck = 2) => ({
    async producer(name) {
      const attempt = executions(crossCheck)[name];
      assert.ok(attempt, name);
      return { attempt, job: { id: attempt * 10, name, run_id: 123 } };
    },
  });
  const paired = { ...pin, artifactId: "55", artifactDigest: hash };
  const proofs = installStepProofs(t);
  const proof = {
    runId: 123,
    attempt: 2,
    slot: "paired-manifest",
    workflow: "fork-builds.yml",
    sourceSha: context.controllerSha,
    evidence: { artifactId: 55, artifactDigest: hash },
  };
  proofs.add(proof);
  const check = (pinned, currentRun, value, ctx = context, jobs = [], at = ledger()) =>
    validateCoordinatedProducer(pinned, currentRun, value, ctx, jobs, at);
  assert.deepEqual(await check(current, current, paired), {
    android: 1,
    androidBuild: 1,
    macos: 2,
  });
  // A cross-check carried over from attempt 1 is pinned, and proven, at attempt 1.
  const carried = { ...current, run_attempt: 1, status: "completed", conclusion: "failure" };
  await assert.rejects(
    check(carried, current, { ...paired, attempt: "1" }, context, [], ledger(1)),
  );
  proofs.add({ ...proof, attempt: 1 });
  await check(carried, current, { ...paired, attempt: "1" }, context, [], ledger(1));
  await assert.rejects(check(current, current, paired, context, [], ledger(1)), /cross-check/);
  await assert.rejects(check(carried, current, { ...paired, attempt: "1" }), /cross-check/);
  const live = {
    id: 11,
    run_id: 123,
    run_attempt: 2,
    name: "native-runtime / macos",
    status: "in_progress",
    conclusion: null,
  };
  const queued = { ...current, status: "queued" };
  await check(current, queued, paired, context, [live]);
  await assert.rejects(check(current, queued, paired));
  await assert.rejects(check(current, queued, paired, context, [{ ...live, run_attempt: 1 }]));
  const branch = "release-please--branches--dev--components--paseo";
  const renamed = { ...current, head_branch: branch };
  await check(renamed, renamed, paired, { ...context, rootBranch: branch });
  await assert.rejects(check(current, current, paired, { ...context, rootBranch: branch }));
  for (const delta of [{ run_attempt: 1 }, { status: "completed" }, { head_sha: sha }])
    await assert.rejects(check(current, { ...current, ...delta }, paired));
  // Upload success is proven by the signed slot, which must name these exact bytes.
  for (const delta of [{ artifactId: "56" }, { artifactDigest: "c".repeat(64) }])
    await assert.rejects(
      check(current, current, { ...paired, ...delta }),
      /another artifact|other artifact bytes/,
    );
  proofs.remove(proof);
  await assert.rejects(check(current, current, paired), /verify/);
  const candidate = candidateFixture();
  candidate.android.artifactRunAttempt = "1";
  candidate.android.artifactName = `paseo-iexalt-201000-${sha}-attempt-1`;
  validateCandidate(candidate, pin);
  validateCandidate(candidate, pin, { android: 1, macos: 2 });
  assert.throws(() => validateCandidate(candidate, pin, { android: 2, macos: 2 }));
});

test("artifact transport rejects a different or unsuccessful producer attempt", () => {
  validateProducer(run, pin);
  for (const delta of [
    { id: 124 },
    { run_attempt: 1 },
    { path: ".github/workflows/ci.yml" },
    { event: "pull_request" },
    { actor: { login: "other" } },
    { head_branch: "other" },
    { head_sha: "f".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
  ]) {
    assert.throws(() => validateProducer({ ...run, ...delta }, pin));
  }
  const artifact = {
    id: 456,
    name: "pinned",
    digest: `sha256:${hash}`,
    expired: false,
    size_in_bytes: 5,
    workflow_run: { id: 123, head_sha: sha, head_branch: "dev" },
  };
  const expected = { id: "456", name: "pinned", digest: hash };
  validateArtifact(artifact, pin, expected, 10);
  const coordinated = {
    ...artifact,
    workflow_run: {
      ...artifact.workflow_run,
      head_branch: "release-please--branches--dev--components--paseo",
    },
  };
  validateArtifact(
    coordinated,
    { ...pin, headBranch: coordinated.workflow_run.head_branch },
    expected,
    10,
  );
  assert.throws(() => validateArtifact(coordinated, pin, expected, 10));
  for (const delta of [
    { id: 457 },
    { name: "latest" },
    { expired: true },
    { size_in_bytes: 11 },
    { size_in_bytes: -1 },
    { digest: `sha256:${"c".repeat(64)}` },
    { workflow_run: { ...artifact.workflow_run, id: 124 } },
  ]) {
    assert.throws(() => validateArtifact({ ...artifact, ...delta }, pin, expected, 10));
  }
});

function candidateFixture() {
  return {
    kind: "paseo-verification-candidate",
    schemaVersion: 2,
    status: "candidate",
    sourceSha: sha,
    forkVersion: "0.1.0",
    runId: "123",
    runAttempt: "2",
    android: {
      artifactId: "456",
      artifactDigest: hash,
      artifactRunAttempt: "1",
      artifactName: `paseo-iexalt-201000-${sha}-attempt-1`,
      packageId: "sh.paseo.iexalt",
      versionCode: "201000",
      signingCertificateSha256: "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459",
      apkSha256: hash,
      metadataSha256: hash,
    },
    macOS: {
      artifactId: "457",
      artifactDigest: hash,
      artifactRunAttempt: "2",
      artifactName: `paseo-nix-closure-${sha}-0.1.0-attempt-2`,
      system: "aarch64-darwin",
      provenance: "local-ci-build",
      nodeSeedProvenance: "local-built-dependency",
      archiveSha256: hash,
      manifestSha256: hash,
      lockHash: hash,
      outputPath: `/nix/store/${"a".repeat(32)}-desktop`,
      manifestPath: `/nix/store/${"b".repeat(32)}-manifest.json`,
    },
  };
}

test("candidate receipt permits earlier successful lane artifacts but rejects future or mixed identity", () => {
  const candidate = candidateFixture();
  validateCandidate(candidate, pin);
  for (const delta of [
    { kind: "release" },
    { schemaVersion: 1 },
    { releaseSequence: 201000 },
    { forkVersion: "0.2.0" },
    { runAttempt: "1" },
    { sourceSha: "f".repeat(40) },
    { android: { ...candidate.android, artifactRunAttempt: "3" } },
    { android: { ...candidate.android, versionCode: "201001" } },
    { macOS: { ...candidate.macOS, outputPath: "../../outside" } },
  ])
    assert.throws(() => validateCandidate({ ...candidate, ...delta }, pin));
});

test("candidate transport follows pinned attempt and selected payload through real ZIP extraction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-candidate-fetch-"));
  const checksum = (body) => createHash("sha256").update(body).digest("hex");
  const zip = (files) =>
    execFileSync("python3", [
      "-c",
      "import io,json,sys,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,'w');[(z.writestr(k,v)) for k,v in json.loads(sys.argv[1]).items()];z.close();sys.stdout.buffer.write(b.getvalue())",
      JSON.stringify(files),
    ]);
  const candidate = candidateFixture();
  const apk = "tiny signed-APK transport fixture";
  const metadata = "{}";
  candidate.android.apkSha256 = checksum(apk);
  candidate.android.metadataSha256 = checksum(metadata);
  const android = zip({
    "paseo-iexalt-fork-201000.apk": apk,
    "paseo-iexalt-fork-201000.apk.idsig": "v4 signature sidecar",
    "build-metadata.json": metadata,
    SHA256SUMS: "",
  });
  candidate.android.artifactDigest = checksum(android);
  const macArchive = "tiny Nix archive transport fixture";
  candidate.macOS.archiveSha256 = checksum(macArchive);
  candidate.macOS.manifestSha256 = checksum(metadata);
  const macos = zip({
    [`${candidate.macOS.artifactName}.tar`]: macArchive,
    "manifest.json": metadata,
    SHA256SUMS: "",
  });
  candidate.macOS.artifactDigest = checksum(macos);
  const paired = zip({ "paired-candidate.json": JSON.stringify(candidate), SHA256SUMS: "" });
  const selectedPin = { ...pin, artifactId: "455", artifactDigest: checksum(paired) };
  const requests = [];
  const request = async (url) => {
    const route = new URL(url).pathname.split("/repos/iExalt/paseo/")[1];
    requests.push(route);
    if (route === "actions/runs/123/attempts/2") return Response.json(run);
    for (const [id, body, name] of [
      [455, paired, `paseo-paired-candidate-0.1.0-${sha}-attempt-2`],
      [456, android, candidate.android.artifactName],
      [457, macos, candidate.macOS.artifactName],
    ]) {
      if (route === `actions/artifacts/${id}/zip`) return new Response(body);
      if (route === `actions/artifacts/${id}`)
        return Response.json({
          id,
          name,
          digest: `sha256:${checksum(body)}`,
          expired: false,
          size_in_bytes: body.length,
          workflow_run: { id: 123, head_sha: sha, head_branch: "dev" },
        });
    }
    throw new Error(`Unexpected artifact request: ${route}`);
  };
  try {
    for (const [platform, file, body, excluded] of [
      ["android", "paseo-iexalt-fork-201000.apk", apk, "457"],
      ["macos", `${candidate.macOS.artifactName}.tar`, macArchive, "456"],
    ]) {
      requests.length = 0;
      const output = join(directory, platform);
      assert.deepEqual(
        await fetchCandidate(selectedPin, output, "fixture-token", platform, request),
        candidate,
      );
      assert.equal(await readFile(join(output, platform, file), "utf8"), body);
      assert.equal(requests.length, 5);
      assert.ok(!requests.some((route) => route.includes(excluded)));
    }
    await assert.rejects(
      fetchCandidate(
        { ...selectedPin, artifactDigest: hash },
        join(directory, "wrong"),
        "fixture-token",
        "android",
        request,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("redirects strip credentials and reject insecure transport", async () => {
  const requests = [];
  await githubResponse("actions/artifacts/456/zip", "private-token", async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://storage.example/zip" } })
      : new Response("zip");
  });
  assert.equal(requests[0].options.headers.Authorization, "Bearer private-token");
  assert.deepEqual(requests[1].options.headers, {});
  await assert.rejects(
    githubResponse(
      "actions/artifacts/456/zip",
      "token",
      async () =>
        new Response(null, { status: 302, headers: { location: "http://storage.example/zip" } }),
    ),
  );
});

test("streamed ZIP bytes are bounded, complete and digest verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-artifact-stream-"));
  const file = join(directory, "artifact.zip");
  const body = Buffer.from("small ZIP fixture");
  const expected = createHash("sha256").update(body).digest("hex");
  try {
    await saveDownload(new Response(body), file, body.length, body.length, expected);
    assert.deepEqual(await readFile(file), body);
    await rm(file);
    for (const [maximum, bytes, checksum] of [
      [body.length - 1, body.length, expected],
      [body.length + 1, body.length + 1, expected],
      [body.length, body.length, hash],
    ]) {
      await assert.rejects(saveDownload(new Response(body), file, maximum, bytes, checksum));
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP extraction enforces exact flat files and excludes symlinks and oversized contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-artifact-zip-"));
  const archive = join(directory, "artifact.zip");
  try {
    for (const [name, mode, maximum, accepted] of [
      ["safe", 0o100600, 10, true],
      ["../safe", 0o100600, 10, false],
      ["safe", 0o120777, 10, false],
      ["safe", 0o100600, 1, false],
    ]) {
      execFileSync("python3", [
        "-c",
        "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');i=zipfile.ZipInfo(sys.argv[2]);i.external_attr=int(sys.argv[3])<<16;z.writestr(i,b'data');z.close()",
        archive,
        name,
        String(mode),
      ]);
      const output = join(directory, "output");
      const extract = () =>
        execFileSync(
          "python3",
          [
            ".github/scripts/extract-candidate-artifact.py",
            archive,
            output,
            String(maximum),
            '["safe"]',
          ],
          { stdio: "pipe" },
        );
      if (accepted) {
        extract();
        assert.equal(await readFile(join(output, "safe"), "utf8"), "data");
      } else assert.throws(extract);
      await rm(output, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
