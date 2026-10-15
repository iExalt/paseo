import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  predecessorRecipe,
  previousSha,
  validateCache,
  verifyArchive,
  writeArchive,
  writer,
} from "../.github/scripts/linux-predecessor-cache.mjs";
import { payloadFiles, digest } from "../packages/desktop/e2e/linux-installed-layout.cjs";

const runner = {
  lockHash: "b".repeat(64),
  architecture: "x64",
  imageOS: "ubuntu24",
  imageVersion: "20261001.1.0",
  producers: { ".github/scripts/linux-product-build.sh": "c".repeat(64) },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-predecessor-cache-"));
  const directory = join(root, "cache");
  mkdirSync(directory);
  const { key: recipe, diagnostics } = predecessorRecipe(runner);
  const identity = {
    sourceSha: previousSha,
    lockHash: recipe.lockHash,
    version: "0.1.0",
    name: "@getpaseo/desktop",
    desktopName: "Paseo.desktop",
    payload: Object.fromEntries(
      [...payloadFiles, "resources/linux-after-install.sh"].map((file) => [file, "c".repeat(64)]),
    ),
    artifacts: {},
  };
  for (const format of ["deb", "rpm", "appimage"]) {
    const file = `previous-x64.${format === "appimage" ? "AppImage" : format}`;
    writeFileSync(join(directory, file), "fixture");
    identity.artifacts[format] = { file, bytes: 7, sha256: digest(join(directory, file)) };
  }
  identity.artifacts.deb.packageName = "paseo";
  identity.artifacts.rpm.packageName = "Paseo";
  identity.artifacts.appimage.appRunSha256 = "d".repeat(64);
  function writeIdentity(value, receipt = {}) {
    writeFileSync(join(directory, "previous.json"), JSON.stringify(value));
    writeFileSync(
      join(directory, "receipt.json"),
      JSON.stringify({
        key: recipe,
        diagnostics,
        producerSha: "e".repeat(40),
        runId: "123",
        attempt: "1",
        identitySha256: digest(join(directory, "previous.json")),
        rpmScriptsSha256: "f".repeat(64),
        ...receipt,
      }),
    );
  }
  writeIdentity(identity);
  return { root, directory, recipe, identity, writeIdentity };
}

test("Linux predecessor key holds only the fixture definition, not producer or image diagnostics", () => {
  const { key } = predecessorRecipe(runner);
  assert.equal(key.schema, 2);
  assert.match(cacheKey(key), /^paseo-linux-predecessor-v2-x64-[a-f0-9]{64}$/);
  for (const diagnostic of [{ imageVersion: "20261008.2.0" }, { producers: {} }])
    assert.equal(cacheKey(predecessorRecipe({ ...runner, ...diagnostic }).key), cacheKey(key));
  for (const field of Object.keys(key))
    assert.notEqual(cacheKey({ ...key, [field]: "changed" }), cacheKey(key), field);
  assert.notEqual(
    cacheKey({ ...key, predecessorFormat: key.predecessorFormat + 1 }),
    cacheKey(key),
  );
});

test("Linux predecessor cache binds the exact key recipe, package bytes and immutable identity", () => {
  const { root, directory, recipe, identity, writeIdentity } = fixture();
  const rpm = join(directory, "previous-x64.rpm");
  try {
    assert.equal(validateCache(directory, recipe).identity.sourceSha, previousSha);
    // The writer's diagnostics are free-form and never decide a hit.
    writeIdentity(identity, { diagnostics: { imageVersion: "other", producers: {} } });
    validateCache(directory, recipe);
    writeIdentity(identity, { diagnostics: "not an object" });
    assert.throws(() => validateCache(directory, recipe), /diagnostics object/);
    writeIdentity(identity, { key: { ...recipe, imageOS: "ubuntu22" } });
    assert.throws(() => validateCache(directory, recipe), /recipe mismatch/);
    writeIdentity(identity);
    truncateSync(rpm, cacheLimit + 1);
    assert.throws(() => validateCache(directory, recipe), /exceeds 650 MiB/);
    rmSync(rpm);
    symlinkSync("previous-x64.deb", rpm);
    assert.throws(() => validateCache(directory, recipe), /Only regular cache files/);
    rmSync(rpm);
    writeFileSync(rpm, "changed");
    assert.throws(() => validateCache(directory, recipe), /Corrupt cached rpm/);
    writeFileSync(rpm, "fixture");
    for (const value of [
      { ...identity, sourceSha: "0".repeat(40) },
      { ...identity, name: "paseo" },
      {
        ...identity,
        artifacts: {
          ...identity.artifacts,
          deb: { ...identity.artifacts.deb, packageName: "Paseo" },
        },
      },
    ]) {
      writeIdentity(value);
      assert.throws(() => validateCache(directory, recipe));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux candidates extract only verified archives and rebuild after any rejection", async () => {
  const { root, directory, recipe } = fixture();
  const archive = join(root, "predecessor.tar");
  const restored = join(root, "restored");
  const paths = { archive, directory: restored };
  const claims = [];
  const verify = async (file, claim) => {
    claims.push(claim);
    return digest(file);
  };
  try {
    writeArchive(directory, archive, recipe);
    const accepted = await verifyArchive(paths, () => recipe, verify);
    assert.equal(accepted.verified, true, accepted.error?.message);
    assert.deepEqual(claims, [{ key: cacheKey(recipe), writer }]);
    assert.equal(validateCache(restored, recipe).identity.sourceSha, previousSha);
    assert.equal(existsSync(archive), false);
    const rejectedBy = async (rejectingVerify, message) => {
      rmSync(restored, { recursive: true, force: true });
      // Packed directly: the writer itself refuses to archive a corrupt stage.
      execFileSync("tar", ["-cf", archive, "-C", directory, ...readdirSync(directory)]);
      const result = await verifyArchive(paths, () => recipe, rejectingVerify);
      assert.equal(result.verified, false);
      assert.match(result.error.message, message);
      assert.equal(existsSync(restored), false);
      assert.equal(existsSync(archive), false);
    };
    await rejectedBy(async () => {
      throw new Error("Build cache was not attested by its dispatched dev writer");
    }, /not attested/);
    writeFileSync(join(directory, "previous-x64.deb"), "corrupt");
    await rejectedBy(verify, /Corrupt cached deb/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
