import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Build caches feed signed release bytes, and any job running on dev, including
// a candidate run, can save a dev-scoped cache key. Only archives attested by a
// writer workflow dispatched directly on dev are restored.
export const BUILD_CACHE_TYPE = "https://github.com/iExalt/paseo/attestations/build-cache/v1";
const repository = "iExalt/paseo";
const origin = `https://github.com/${repository}`;
const ref = "refs/heads/dev";

export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function buildCachePredicate(key) {
  assert.match(key, /^[a-z0-9][a-z0-9._-]{8,200}$/, "Malformed build cache key");
  return { schemaVersion: 1, kind: "paseo-build-cache", key };
}

// Attestation services may reorder predicate keys.
const samePredicate = (actual, expected) =>
  actual !== null &&
  typeof actual === "object" &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([name, value]) => actual[name] === value);

export function acceptsBuildCache(result, expected, digest) {
  const { statement, signature } = result.verificationResult;
  const certificate = signature.certificate;
  const writer = `${origin}/.github/workflows/${expected.writer}@${ref}`;
  return (
    statement._type === "https://in-toto.io/Statement/v1" &&
    statement.predicateType === BUILD_CACHE_TYPE &&
    statement.subject.length === 1 &&
    statement.subject[0].digest?.sha256 === digest &&
    samePredicate(statement.predicate, buildCachePredicate(expected.key)) &&
    certificate.issuer === "https://token.actions.githubusercontent.com" &&
    certificate.runnerEnvironment === "github-hosted" &&
    certificate.sourceRepositoryURI === origin &&
    certificate.sourceRepositoryIdentifier === "1404390841" &&
    certificate.sourceRepositoryRef === ref &&
    // A reusable writer called by a candidate run signs as itself, so the
    // top-level workflow and its trigger tell a dispatched writer apart.
    certificate.buildSignerURI === writer &&
    certificate.buildConfigURI === writer &&
    certificate.buildTrigger === "workflow_dispatch"
  );
}

// Archives hold regular files and directories only, all inside their roots and
// none under an excluded link.
export function checkArchiveListing(names, verbose, roots, links = []) {
  assert.equal(names.length, verbose.length);
  assert.ok(names.length > 0, "Empty installed dependency archive");
  for (const [index, name] of names.entries()) {
    assert.match(verbose[index], /^[d-]/, `Archive entry is not a file or directory: ${name}`);
    assert.ok(!/^[a-z]:|^[\\/]/i.test(name), `Absolute archive entry: ${name}`);
    assert.ok(!name.split(/[\\/]/).includes(".."), `Escaping archive entry: ${name}`);
    assert.ok(
      roots.some((root) => name === root || name.startsWith(`${root}/`)),
      `Archive entry outside its roots: ${name}`,
    );
    assert.ok(
      !links.some((link) => name === link || name.startsWith(`${link}/`)),
      `Archive carries a workspace link target: ${name}`,
    );
  }
}

// Predecessor caches archive a flat staging directory holding exactly these files.
export function checkExactListing(names, verbose, inventory) {
  checkArchiveListing(names, verbose, inventory);
  assert.deepEqual([...names].sort(), [...inventory].sort(), "Exact archive inventory required");
}

function checkExactArchive(archive, inventory, tar) {
  const list = (flags) =>
    execFileSync(tar, [flags, archive], { encoding: "utf8", timeout: 60_000 })
      .split(/\r?\n/)
      .filter(Boolean);
  checkExactListing(
    list("-tf").map((name) => name.replace(/\/$/, "")),
    list("-tvf"),
    inventory,
  );
}

export function writeExactArchive(directory, archive, { inventory, limit, tar }) {
  assert.equal(existsSync(archive), false);
  execFileSync(tar, ["-cf", archive, "-C", directory, ...inventory], { timeout: 600_000 });
  checkExactArchive(archive, inventory, tar);
  const bytes = statSync(archive).size;
  assert.ok(bytes <= limit, "Archive exceeds its cache reservation");
  return bytes;
}

// Throws on any rejection; callers turn that into a miss and remove what was extracted.
export async function extractAttested(
  archive,
  directory,
  { key, writer, inventory, limit, tar },
  verify = verifyBuildCache,
) {
  assert.ok(statSync(archive).size <= limit, "Archive exceeds its cache reservation");
  const digest = await verify(archive, { key, writer });
  checkExactArchive(archive, inventory, tar);
  assert.equal(existsSync(directory), false, "Refuse an existing extraction directory");
  mkdirSync(directory, { recursive: true });
  execFileSync(tar, ["-xf", archive, "-C", directory], { timeout: 600_000 });
  return digest;
}

function verifyWithGh(file, expected) {
  return JSON.parse(
    execFileSync(
      "gh",
      [
        "attestation",
        "verify",
        file,
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/.github/workflows/${expected.writer}`,
        "--source-ref",
        ref,
        "--predicate-type",
        BUILD_CACHE_TYPE,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
    ),
  );
}

export async function verifyBuildCache(
  file,
  expected,
  { verify = verifyWithGh, pause = sleep } = {},
) {
  assert.match(expected.writer, /^[a-z0-9-]+\.yml$/);
  buildCachePredicate(expected.key);
  const digest = await fileDigest(file);
  let results, failure;
  for (let attempt = 0; attempt < 3 && !results; attempt++) {
    if (attempt) await pause(attempt * 5000);
    try {
      results = await verify(file, expected);
    } catch (error) {
      failure = error;
    }
  }
  if (!results) throw new Error("Build cache attestation did not verify", { cause: failure });
  assert.ok(
    Array.isArray(results) && results.some((result) => acceptsBuildCache(result, expected, digest)),
    "Build cache was not attested by its dispatched dev writer",
  );
  return digest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, key, writer] = process.argv.slice(2);
  const digest = await verifyBuildCache(resolve(file), { key, writer });
  console.log(`Verified build cache ${key} (${digest}) from ${writer}`);
}
