import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  previousSha,
  validateCache,
} from "../.github/scripts/windows-predecessor-cache.mjs";
import { digest } from "../.github/scripts/windows-speech-binding.mjs";

test("Windows predecessor cache binds exact recipe and portable identity before consuming verified bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-windows-cache-"));
  const directory = join(root, "cache");
  mkdirSync(directory);
  try {
    const recipe = {
      architecture: "arm64",
      lockSha256: "a".repeat(64),
      bindingProvenance: { inputs: "pinned" },
    };
    const filename = "previous-arm64.exe";
    const installer = join(directory, filename);
    const content = "installer fixture";
    writeFileSync(installer, content);
    const identity = {
      sourceSha: previousSha,
      lockSha256: recipe.lockSha256,
      version: "0.11.0",
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
    function writeIdentity(value) {
      writeFileSync(join(directory, "previous.json"), JSON.stringify(value));
      writeFileSync(
        join(directory, "receipt.json"),
        JSON.stringify({
          recipe,
          producerSha: "d".repeat(40),
          runId: "123",
          attempt: "1",
          identitySha256: digest(readFileSync(join(directory, "previous.json"))),
        }),
      );
    }
    writeIdentity(identity);
    assert.equal(validateCache(directory, recipe).identity.sourceSha, previousSha);
    const destination = join(root, "consumer");
    mkdirSync(join(destination, "evidence"), { recursive: true });
    const restored = consumeCache(directory, recipe, destination);
    assert.equal(restored.installer.filename, join(destination, "packages/previous", filename));
    assert.equal(readFileSync(restored.installer.filename, "utf8"), content);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "previous.json"))), restored);
    assert.throws(
      () => consumeCache(directory, recipe, destination),
      /Empty predecessor destination/,
    );
    const changed = { ...recipe, lockSha256: "e".repeat(64) };
    assert.notEqual(cacheKey(recipe), cacheKey(changed));
    assert.throws(() => validateCache(directory, changed), /recipe mismatch/);
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
