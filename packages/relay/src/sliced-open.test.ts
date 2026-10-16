import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { openAfterInSlices, type SliceScheduler } from "./sliced-open.js";

// Yields at every budget check, which comes once per 1 KB of keystream.
function countingScheduler(): SliceScheduler & { yields: number } {
  return {
    yields: 0,
    shouldYield: () => true,
    async yield() {
      this.yields += 1;
    },
  };
}

function seal(length: number) {
  const sharedKey = nacl.box.before(nacl.randomBytes(32), nacl.randomBytes(32));
  const nonce = nacl.randomBytes(24);
  const plaintext = nacl.randomBytes(length);
  return { sharedKey, nonce, plaintext, box: nacl.box.after(plaintext, nonce, sharedKey) };
}

describe("openAfterInSlices", () => {
  it.each([0, 1, 15, 16, 31, 32, 33, 63, 64, 65, 96, 97, 4096, 70_000, 1_048_576])(
    "matches nacl.box.open.after for a %i-byte plaintext",
    async (length) => {
      const { sharedKey, nonce, plaintext, box } = seal(length);
      const scheduler = countingScheduler();

      const opened = await openAfterInSlices(box, nonce, sharedKey, scheduler);

      expect(opened).toEqual(nacl.box.open.after(box, nonce, sharedKey));
      expect(opened).toEqual(plaintext);
      // Blocks 16, 32, ... are each preceded by a check; block 0 also covers the first 32 bytes.
      expect(scheduler.yields).toBe(Math.floor(Math.ceil(Math.max(0, length - 32) / 64) / 16));
    },
  );

  it.each([
    { label: "tag", index: 0 },
    { label: "first ciphertext byte", index: 16 },
    { label: "last ciphertext byte", index: -1 },
  ])("rejects a box with a tampered $label before yielding any plaintext", async ({ index }) => {
    const { sharedKey, nonce, box } = seal(10_000);
    box[index < 0 ? box.length + index : index]! ^= 1;
    const scheduler = countingScheduler();

    const opened = await openAfterInSlices(box, nonce, sharedKey, scheduler);

    expect(opened).toBeNull();
    expect(scheduler.yields).toBe(0);
  });

  it("rejects a box shorter than its tag", async () => {
    const { sharedKey, nonce } = seal(0);

    expect(
      await openAfterInSlices(new Uint8Array(15), nonce, sharedKey, countingScheduler()),
    ).toBeNull();
  });
});
