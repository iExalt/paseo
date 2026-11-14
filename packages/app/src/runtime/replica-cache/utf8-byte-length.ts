// Counts how many bytes a string occupies as UTF-8, for replica budget accounting.
//
// A native encoder (it has encodeInto; the app's Buffer-backed polyfill does not) counts in native
// code. The JS loop is ~500x slower on an interpreter and stays only as the fallback, because the
// polyfill materialises the bytes through Buffer.
const nativeTextEncoder =
  typeof TextEncoder === "function" && typeof TextEncoder.prototype.encodeInto === "function"
    ? new TextEncoder()
    : null;

export function utf8ByteLength(text: string): number {
  if (nativeTextEncoder) return nativeTextEncoder.encode(text).byteLength;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
