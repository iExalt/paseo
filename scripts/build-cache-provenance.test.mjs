import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILD_CACHE_TYPE,
  buildCachePredicate,
  checkExactListing,
  fileDigest,
  verifyBuildCache,
} from "../.github/scripts/build-cache-provenance.mjs";

const origin = "https://github.com/iExalt/paseo";
const writer = "windows-product-runtime.yml";
const key = "paseo-windows-modules-v1-arm64-" + "a".repeat(64);

function signed(digest, overrides = {}) {
  const signer = `${origin}/.github/workflows/${writer}@refs/heads/dev`;
  return {
    verificationResult: {
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: BUILD_CACHE_TYPE,
        subject: [{ digest: { sha256: digest } }],
        predicate: overrides.predicate ?? buildCachePredicate(key),
      },
      signature: {
        certificate: {
          issuer: "https://token.actions.githubusercontent.com",
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: origin,
          sourceRepositoryIdentifier: "1404390841",
          sourceRepositoryRef: "refs/heads/dev",
          buildSignerURI: signer,
          buildConfigURI: signer,
          buildTrigger: "workflow_dispatch",
          ...overrides.certificate,
        },
      },
    },
  };
}

test("build caches restore only archives attested by their dispatched dev writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-build-cache-"));
  try {
    const file = join(directory, "modules.tar");
    writeFileSync(file, "archive bytes");
    const digest = await fileDigest(file);
    const expected = { key, writer };
    const verifyWith = (results) =>
      verifyBuildCache(file, expected, { verify: async () => results, pause: async () => {} });
    assert.equal(await verifyWith([signed(digest)]), digest);
    // Another, unrelated attestation for the same bytes does not hide a valid one.
    assert.equal(
      await verifyWith([signed(digest, { certificate: { buildTrigger: "push" } }), signed(digest)]),
      digest,
    );
    for (const rejected of [
      // A candidate run calls the same reusable writer and can save dev-scoped keys.
      signed(digest, {
        certificate: {
          buildConfigURI: `${origin}/.github/workflows/release-candidate.yml@refs/heads/dev`,
          buildTrigger: "pull_request_target",
        },
      }),
      signed(digest, { certificate: { buildTrigger: "push" } }),
      signed(digest, { certificate: { sourceRepositoryRef: "refs/pull/1/merge" } }),
      signed(digest, { certificate: { runnerEnvironment: "self-hosted" } }),
      signed(digest, { predicate: buildCachePredicate(key.replace("arm64", "x64")) }),
      signed("0".repeat(64)),
    ])
      await assert.rejects(verifyWith([rejected]), /dispatched dev writer/);
    let calls = 0;
    await assert.rejects(
      verifyBuildCache(file, expected, {
        verify: async () => {
          calls++;
          throw new Error("no attestations");
        },
        pause: async () => {},
      }),
      /did not verify/,
    );
    assert.equal(calls, 3);
    assert.throws(() => buildCachePredicate("../escape"), /Malformed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("predecessor archives carry exactly their staged inventory", () => {
  const names = ["previous-arm64.exe", "previous.json", "receipt.json"];
  const files = names.map(() => "-rw-r--r-- 0 runner runner 7 Oct 14 00:00 name");
  checkExactListing(names, files, names);
  assert.throws(() => checkExactListing(names.slice(1), files.slice(1), names), /inventory/);
  assert.throws(
    () => checkExactListing([...names, "receipt.json/x"], [...files, files[0]], names),
    /inventory/,
  );
  assert.throws(
    () => checkExactListing(names, ["lrwxr-xr-x link", ...files.slice(1)], names),
    /not a file or directory/,
  );
});
