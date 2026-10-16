import { afterEach, describe, expect, it, vi } from "vitest";

const BYTES = Uint8Array.from({ length: 67 }, (_, index) =>
  index < 3 ? 255 : (index * 37 + 251) % 256,
);
// Contains "+", "/" and "=" padding, so every normalization below is exercised.
const STANDARD = Buffer.from(BYTES).toString("base64");

async function loadBase64(decoder: "fromBase64" | "atob" | "base64-js") {
  vi.resetModules();
  if (decoder !== "fromBase64") {
    Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true });
  }
  if (decoder === "base64-js") vi.stubGlobal("atob", undefined);
  return import("./base64.js");
}

const originalFromBase64 = (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;

afterEach(() => {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: originalFromBase64,
    configurable: true,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["fromBase64", "atob", "base64-js"] as const)(
  "base64ToArrayBuffer with %s",
  (decoder) => {
    it.each([
      { label: "standard", input: STANDARD },
      { label: "url-safe", input: STANDARD.replace(/\+/g, "-").replace(/\//g, "_") },
      { label: "unpadded", input: STANDARD.replace(/=+$/, "") },
      { label: "whitespace-wrapped", input: ` ${STANDARD}\n` },
    ])("decodes $label input", async ({ input }) => {
      const { base64ToArrayBuffer } = await loadBase64(decoder);
      expect(new Uint8Array(base64ToArrayBuffer(input))).toEqual(BYTES);
    });
  },
);
