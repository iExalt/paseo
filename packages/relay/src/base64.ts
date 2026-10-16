import { fromByteArray, toByteArray } from "base64-js";

type FromBase64 = (base64: string) => Uint8Array;

// Every relay frame is base64 text, and base64-js decodes in JavaScript (about 50 ms per MB on
// Hermes). Prefer the runtime's decoder: Uint8Array.fromBase64 where it exists, else atob, which
// Hermes and Node provide. Both skip ASCII whitespace and accept missing padding.
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64;
const nativeAtob = typeof globalThis.atob === "function" ? globalThis.atob : undefined;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return fromByteArray(new Uint8Array(buffer));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const standard = /[-_]/.test(base64) ? base64.replace(/-/g, "+").replace(/_/g, "/") : base64;
  if (nativeFromBase64) return nativeFromBase64(standard).buffer as ArrayBuffer;
  if (nativeAtob) {
    const binary = nativeAtob(standard);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  const trimmed = standard.trim();
  const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
  const bytes = toByteArray(padded);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
