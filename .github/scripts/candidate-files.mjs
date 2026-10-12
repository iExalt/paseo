import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";

export const packageLimit = 2 * 1024 ** 3;
export function fileIdentity(expected) {
  assert.ok(
    Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= packageLimit,
  );
  assert.match(expected.sha256, /^[a-f0-9]{64}$/);
}

export async function verifyStream(stream, expected) {
  fileIdentity(expected);
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    bytes += chunk.length;
    assert.ok(bytes <= expected.bytes, "Package exceeds admitted byte count");
    hash.update(chunk);
  }
  assert.equal(bytes, expected.bytes, "Truncated package transfer");
  assert.equal(hash.digest("hex"), expected.sha256, "Package digest differs");
}

// Keep one verified file handle across preflight and upload. Replacement paths
// cannot substitute bytes, and the upload itself rechecks actual bytes/digest.
export async function withVerifiedFile(file, expected, consume) {
  fileIdentity(expected);
  const pathInfo = await lstat(file);
  assert.ok(pathInfo.isFile(), "Package must be a regular file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assert.ok(before.isFile());
    assert.equal(before.ino, pathInfo.ino);
    assert.equal(before.dev, pathInfo.dev);
    assert.equal(before.size, expected.bytes);
    const stream = () => handle.createReadStream({ start: 0, autoClose: false });
    await verifyStream(stream(), expected);
    let sent = false;
    const body = async function* () {
      let bytes = 0;
      const hash = createHash("sha256");
      for await (const chunk of stream()) {
        bytes += chunk.length;
        assert.ok(bytes <= expected.bytes);
        hash.update(chunk);
        yield chunk;
      }
      assert.equal(bytes, expected.bytes);
      assert.equal(hash.digest("hex"), expected.sha256);
      sent = true;
    };
    const result = await consume(body());
    assert.equal(sent, true, "Upload did not consume the verified file");
    const after = await handle.stat();
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    return result;
  } finally {
    await handle.close();
  }
}
