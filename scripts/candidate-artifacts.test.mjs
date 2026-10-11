import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  fetchCandidate,
  githubResponse,
  saveDownload,
  validateArtifact,
  validateCandidate,
  validateProducer,
} from "../.github/scripts/candidate-artifacts.mjs";

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
