import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apkDeltaAssetName, makeApkDelta } from "./release-android-delta.mjs";

test("APK deltas rebuild the signed APK and are kept only when they halve the .gz", async () => {
  const work = await mkdtemp(join(tmpdir(), "paseo-apk-delta-"));
  try {
    const baseBytes = randomBytes(64 * 1024);
    const nextBytes = Buffer.concat([
      baseBytes.subarray(0, 30_000),
      randomBytes(100),
      baseBytes.subarray(30_000),
    ]);
    const base = { version: "1.2.2", bytes: baseBytes.length, file: join(work, "base.apk") };
    const nextFile = join(work, "paseo-1.2.3-android-arm64.apk");
    await writeFile(base.file, baseBytes);
    await writeFile(nextFile, nextBytes);
    const next = {
      file: nextFile,
      bytes: nextBytes.length,
      sha256: createHash("sha256").update(nextBytes).digest("hex"),
      gzipBytes: nextBytes.length,
    };
    const directory = join(work, "out");
    await mkdir(directory);
    const make = (overrides) => makeApkDelta({ base, next, directory, work, ...overrides });

    const size = await make({});
    assert.ok(size > 0 && size < 1_000, `delta of ${size} bytes`);
    assert.deepEqual(await readdir(directory), [
      apkDeltaAssetName("paseo-1.2.3-android-arm64.apk", "1.2.2"),
    ]);

    await rm(directory, { recursive: true });
    await mkdir(directory);
    assert.equal(await make({ next: { ...next, gzipBytes: size * 2 } }), null, "saves too little");
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(make({ next: { ...next, sha256: "0".repeat(64) } }), /does not rebuild/);
    let ran = false;
    const zstd = () => (ran = true);
    assert.equal(
      await make({ base: { ...base, bytes: 2 ** 28 + 1 }, zstd }),
      null,
      "past the window",
    );
    assert.equal(ran, false);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("APK delta names carry a plain base version", () => {
  assert.equal(
    apkDeltaAssetName("paseo-1.2.3-android-arm64.apk", "1.2.2"),
    "paseo-1.2.3-android-arm64.apk.delta-from-1.2.2.zst",
  );
  assert.throws(() => apkDeltaAssetName("paseo-1.2.3-android-arm64.apk", "../1.2.2"));
  assert.throws(() => apkDeltaAssetName("paseo-1.2.3.apk", "1.2.2"));
});
