import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cacheKey,
  cacheLimit,
  consumeCache,
  lockIdentity,
  predecessorRecipe,
  previousSha,
  restoreArchive,
  validateCache,
  writeArchive,
  writer,
} from "../.github/scripts/windows-predecessor-cache.mjs";
import { digest } from "../.github/scripts/windows-speech-binding.mjs";

const runner = {
  lock: { lockBlobSha256: "a".repeat(64), lockSha256: "b".repeat(64) },
  architecture: "arm64",
  imageOS: "win11-arm",
  imageVersion: "20261001.1.0",
  bindingProvenance: { inputs: "pinned" },
  producers: { "windows-product-build.mjs": "c".repeat(64) },
  compiler: "C:\\VS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\HostArm64\\arm64\\cl.exe",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-windows-cache-"));
  const directory = join(root, "cache");
  mkdirSync(directory);
  const blob = '{"lockfileVersion":3}\n';
  const checkout = join(root, "package-lock.json");
  writeFileSync(checkout, blob.replaceAll("\n", "\r\n"));
  const { key: recipe, diagnostics } = predecessorRecipe({
    ...runner,
    lock: lockIdentity(blob, checkout),
  });
  const filename = "previous-arm64.exe";
  const installer = join(directory, filename);
  const content = "installer fixture";
  writeFileSync(installer, content);
  const identity = {
    sourceSha: previousSha,
    lockSha256: recipe.lockSha256,
    version: "0.1.0",
    architecture: "arm64",
    appId: "sh.paseo.desktop",
    archiveFilter: "BCJ",
    reconstruction: "Fixed source rebuilt with documented current binding and NSIS assembly",
    payload: Object.fromEntries(
      [
        "Paseo.exe",
        "resources/app.asar",
        "resources/bin/paseo.cmd",
        "resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
      ].map((name) => [name, "b".repeat(64)]),
    ),
    binding: {
      architecture: "arm64",
      sherpa: "1.13.8",
      electron: "44.6.0",
      onnxruntime: "1.28.2",
      provenance: recipe.bindingProvenance,
      files: ["sherpa-onnx.node", "onnxruntime.dll", "sherpa-onnx-c-api.dll"].map((name) => ({
        name,
        bytes: 7,
        sha256: "c".repeat(64),
      })),
    },
    installer: { filename, bytes: content.length, sha256: digest(content) },
  };
  function writeIdentity(value, receipt = {}) {
    writeFileSync(join(directory, "previous.json"), JSON.stringify(value));
    writeFileSync(
      join(directory, "receipt.json"),
      JSON.stringify({
        key: recipe,
        diagnostics,
        producerSha: "d".repeat(40),
        runId: "123",
        attempt: "1",
        identitySha256: digest(readFileSync(join(directory, "previous.json"))),
        ...receipt,
      }),
    );
  }
  writeIdentity(identity);
  return { root, directory, blob, checkout, recipe, installer, content, identity, writeIdentity };
}

test("Windows predecessor key holds only the fixture definition, not producer or image diagnostics", () => {
  const { key } = predecessorRecipe(runner);
  assert.equal(key.schema, 2);
  assert.match(cacheKey(key), /^paseo-windows-predecessor-v2-arm64-[a-f0-9]{64}$/);
  for (const diagnostic of [
    { imageVersion: "20261008.2.0" },
    { producers: { "windows-product-build.mjs": "e".repeat(64) } },
    { compiler: undefined },
  ])
    assert.equal(cacheKey(predecessorRecipe({ ...runner, ...diagnostic }).key), cacheKey(key));
  assert.equal(predecessorRecipe({ ...runner, architecture: "x64" }).key.bindingProvenance, null);
  for (const field of Object.keys(key))
    assert.notEqual(cacheKey({ ...key, [field]: "changed" }), cacheKey(key), field);
  assert.notEqual(
    cacheKey({ ...key, predecessorFormat: key.predecessorFormat + 1 }),
    cacheKey(key),
  );
});

test("Windows predecessor cache binds exact recipe and portable identity before consuming verified bytes", () => {
  const { root, directory, blob, checkout, recipe, installer, content, identity, writeIdentity } =
    fixture();
  try {
    assert.equal(recipe.lockBlobSha256, digest(blob));
    assert.equal(recipe.lockSha256, digest(readFileSync(checkout)));
    assert.notEqual(recipe.lockBlobSha256, recipe.lockSha256);
    assert.equal(validateCache(directory, recipe).identity.sourceSha, previousSha);
    // The writer's diagnostics are free-form and never decide a hit.
    writeIdentity(identity, { diagnostics: { imageVersion: "other", producers: {} } });
    validateCache(directory, recipe);
    writeIdentity(identity, { diagnostics: ["not", "an", "object"] });
    assert.throws(() => validateCache(directory, recipe), /diagnostics object/);
    writeIdentity(identity, { key: { ...recipe, imageOS: "win25" } });
    assert.throws(() => validateCache(directory, recipe), /recipe mismatch/);
    writeIdentity(identity);
    const destination = join(root, "consumer");
    mkdirSync(join(destination, "evidence"), { recursive: true });
    const restored = consumeCache(directory, recipe, destination);
    assert.equal(
      restored.installer.filename,
      join(destination, "packages/previous", "previous-arm64.exe"),
    );
    assert.equal(readFileSync(restored.installer.filename, "utf8"), content);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "previous.json"))), restored);
    assert.throws(
      () => consumeCache(directory, recipe, destination),
      /Empty predecessor destination/,
    );
    for (const changed of [
      { ...recipe, lockSha256: "e".repeat(64) },
      { ...recipe, lockBlobSha256: recipe.lockSha256 },
    ]) {
      assert.notEqual(cacheKey(recipe), cacheKey(changed));
      assert.throws(() => validateCache(directory, changed), /recipe mismatch/);
    }
    writeFileSync(installer, content.replace("fixture", "corrupt"));
    assert.throws(() => validateCache(directory, recipe), /Corrupt cached installer/);
    writeFileSync(installer, content);
    for (const value of [
      { ...identity, installer: { ...identity.installer, filename: "../outside.exe" } },
      { ...identity, sourceSha: "f".repeat(40) },
      { ...identity, reconstruction: "original published artifact" },
      { ...identity, binding: { ...identity.binding, provenance: { inputs: "different" } } },
    ]) {
      writeIdentity(value);
      assert.throws(() => validateCache(directory, recipe));
    }
    writeIdentity(identity);
    truncateSync(installer, cacheLimit + 1);
    assert.throws(() => validateCache(directory, recipe), /exceeds 200 MiB/);
    rmSync(installer);
    symlinkSync("previous.json", installer);
    assert.throws(() => validateCache(directory, recipe), /Regular cache files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows candidates consume only verified archives and rebuild after any rejection", async () => {
  const { root, directory, recipe, installer, content } = fixture();
  const archive = join(root, "predecessor.tar");
  const consumer = join(root, "consumer");
  const restoreTo = join(root, "restored");
  const paths = { archive, directory: restoreTo, root: consumer };
  const reset = () => {
    rmSync(consumer, { recursive: true, force: true });
    mkdirSync(join(consumer, "evidence"), { recursive: true });
  };
  const expected = [];
  const verify = async (file, claim) => {
    expected.push(claim);
    return digest(readFileSync(file));
  };
  try {
    writeArchive(directory, archive, recipe);
    reset();
    const accepted = await restoreArchive(paths, () => recipe, { verify });
    assert.equal(accepted.verified, true, accepted.error?.message);
    assert.deepEqual(expected, [{ key: cacheKey(recipe), writer }]);
    assert.equal(readFileSync(accepted.identity.installer.filename, "utf8"), content);
    assert.equal(existsSync(archive), false);

    const rejectedBy = async (options, message) => {
      rmSync(restoreTo, { recursive: true, force: true });
      // Packed directly: the writer itself refuses to archive a corrupt stage.
      execFileSync("tar", ["-cf", archive, "-C", directory, ...readdirSync(directory)]);
      reset();
      const result = await restoreArchive(paths, () => recipe, options);
      assert.equal(result.verified, false);
      assert.match(result.error.message, message);
      assert.equal(existsSync(restoreTo), false);
      assert.equal(existsSync(archive), false);
      for (const consumed of [
        "packages/previous",
        "previous.json",
        "evidence/predecessor-cache.json",
      ])
        assert.equal(existsSync(join(consumer, consumed)), false, consumed);
    };
    await rejectedBy(
      {
        verify: async () => {
          throw new Error("Build cache was not attested by its dispatched dev writer");
        },
      },
      /not attested/,
    );
    writeFileSync(installer, content.replace("fixture", "corrupt"));
    await rejectedBy({ verify }, /Corrupt cached installer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
