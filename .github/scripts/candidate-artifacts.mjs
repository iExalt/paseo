import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { forkAndroidVersionCode } from "../../scripts/fork-version.mjs";

const repository = "iExalt/paseo";
const certificate = "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459";
const extractor = fileURLToPath(new URL("./extract-candidate-artifact.py", import.meta.url));
const MiB = 1024 * 1024;

function integer(value) {
  assert.match(String(value), /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(Number(value)));
  return Number(value);
}

function digest(value) {
  assert.match(value, /^[a-f0-9]{64}$/);
  return value;
}

export function validateProducer(run, pin) {
  assert.equal(run.id, integer(pin.runId));
  assert.equal(run.run_attempt, integer(pin.attempt));
  assert.equal(run.path, ".github/workflows/fork-builds.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.actor?.login, "iExalt");
  assert.equal(run.head_branch, "dev");
  assert.match(pin.sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(run.head_sha, pin.sourceSha);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
}

export function validateArtifact(artifact, pin, expected, maximum) {
  assert.equal(artifact.id, integer(expected.id));
  assert.equal(artifact.name, expected.name);
  assert.equal(artifact.digest, `sha256:${digest(expected.digest)}`);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, integer(pin.runId));
  assert.equal(artifact.workflow_run?.head_sha, pin.sourceSha);
  assert.equal(artifact.workflow_run?.head_branch, "dev");
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0);
  assert.ok(artifact.size_in_bytes <= maximum, "Artifact exceeds download bound");
}

export function validateCandidate(candidate, pin) {
  assert.equal(candidate.kind, "paseo-verification-candidate");
  assert.equal(candidate.schemaVersion, 2);
  assert.ok(!Object.hasOwn(candidate, "releaseSequence"));
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.sourceSha, pin.sourceSha);
  assert.equal(candidate.forkVersion, pin.version);
  assert.equal(candidate.runId, String(pin.runId));
  assert.equal(candidate.runAttempt, String(pin.attempt));
  const code = forkAndroidVersionCode(pin.version);
  const android = candidate.android;
  const mac = candidate.macOS;
  for (const lane of [android, mac]) {
    assert.ok(integer(lane.artifactRunAttempt) <= integer(pin.attempt));
    integer(lane.artifactId);
    digest(lane.artifactDigest);
  }
  assert.equal(android.packageId, "sh.paseo.iexalt");
  assert.equal(android.versionCode, String(code));
  assert.equal(android.signingCertificateSha256, certificate);
  assert.equal(
    android.artifactName,
    `paseo-iexalt-${code}-${pin.sourceSha}-attempt-${android.artifactRunAttempt}`,
  );
  assert.equal(
    mac.artifactName,
    `paseo-nix-closure-${pin.sourceSha}-${pin.version}-attempt-${mac.artifactRunAttempt}`,
  );
  assert.equal(mac.system, "aarch64-darwin");
  assert.equal(mac.provenance, "local-ci-build");
  assert.equal(mac.nodeSeedProvenance, "local-built-dependency");
  for (const value of [
    android.apkSha256,
    android.metadataSha256,
    mac.archiveSha256,
    mac.manifestSha256,
    mac.lockHash,
  ])
    digest(value);
  for (const value of [mac.outputPath, mac.manifestPath])
    assert.match(value, /^\/nix\/store\/[a-z0-9]{32}-[a-zA-Z0-9+._?=-]+$/);
  return candidate;
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Authentication is sent only to the initial GitHub API request. Redirects are
// bounded HTTPS requests without credentials, including on the same origin.
export async function githubResponse(route, token, request = fetch) {
  let url = `https://api.github.com/repos/${repository}/${route}`;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await request(url, {
      headers:
        redirects === 0
          ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
          : {},
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get("location"), url);
      assert.equal(next.protocol, "https:");
      assert.equal(next.username + next.password, "");
      await response.body?.cancel();
      url = next.href;
      continue;
    }
    assert.equal(response.status, 200, `GitHub artifact request failed: ${response.status}`);
    return response;
  }
  throw new Error("Artifact redirect limit exceeded");
}

export async function saveDownload(response, file, maximum, expectedBytes, expectedDigest) {
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(
      response.body,
      new Transform({
        transform(chunk, _encoding, callback) {
          try {
            bytes += chunk.length;
            assert.ok(bytes <= maximum && bytes <= expectedBytes, "Artifact body exceeds bound");
            hash.update(chunk);
            callback(null, chunk);
          } catch (error) {
            callback(error);
          }
        },
      }),
      handle.createWriteStream(),
    );
    assert.equal(bytes, expectedBytes, "Truncated artifact download");
    assert.equal(hash.digest("hex"), digest(expectedDigest), "Artifact ZIP digest mismatch");
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
}

export async function fetchCandidate(pin, directory, token, platform, request = fetch) {
  assert.ok(["android", "macos"].includes(platform));
  const json = async (route) => (await githubResponse(route, token, request)).json();
  validateProducer(
    await json(`actions/runs/${integer(pin.runId)}/attempts/${integer(pin.attempt)}`),
    pin,
  );
  forkAndroidVersionCode(pin.version);
  await mkdir(directory, { recursive: false });
  async function artifact(expected, subdirectory, names, maximum) {
    const id = integer(expected.id);
    const metadata = await json(`actions/artifacts/${id}`);
    validateArtifact(metadata, pin, expected, maximum + MiB);
    const zip = join(directory, `${subdirectory}.zip`);
    await saveDownload(
      await githubResponse(`actions/artifacts/${id}/zip`, token, request),
      zip,
      maximum + MiB,
      metadata.size_in_bytes,
      expected.digest,
    );
    const destination = join(directory, subdirectory);
    execFileSync("python3", [extractor, zip, destination, String(maximum), JSON.stringify(names)], {
      stdio: "pipe",
      timeout: 120_000,
    });
    await rm(zip);
    return destination;
  }
  const paired = await artifact(
    {
      id: pin.artifactId,
      digest: pin.artifactDigest,
      name: `paseo-paired-candidate-${pin.version}-${pin.sourceSha}-attempt-${pin.attempt}`,
    },
    "paired",
    ["paired-candidate.json", "SHA256SUMS"],
    MiB,
  );
  const candidate = validateCandidate(
    JSON.parse(await readFile(join(paired, "paired-candidate.json"), "utf8")),
    pin,
  );
  for (const [name, lane, files, maximum] of [
    [
      "android",
      candidate.android,
      {
        [`paseo-iexalt-fork-${candidate.android.versionCode}.apk`]: candidate.android.apkSha256,
        "build-metadata.json": candidate.android.metadataSha256,
      },
      513 * MiB,
    ],
    [
      "macos",
      candidate.macOS,
      {
        [`${candidate.macOS.artifactName}.tar`]: candidate.macOS.archiveSha256,
        "manifest.json": candidate.macOS.manifestSha256,
      },
      2049 * MiB,
    ],
  ]) {
    if (name !== platform) continue;
    const destination = await artifact(
      { id: lane.artifactId, digest: lane.artifactDigest, name: lane.artifactName },
      name,
      [...Object.keys(files), "SHA256SUMS"],
      maximum,
    );
    for (const [file, expected] of Object.entries(files))
      assert.equal(
        await hashFile(join(destination, file)),
        expected,
        "Candidate payload digest mismatch",
      );
  }
  return candidate;
}
