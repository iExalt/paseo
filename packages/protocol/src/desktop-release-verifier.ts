/** Node-only verification shared by the desktop app and shipped Nix helper. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL } from "./release-manifest.ts";
import { validateForkReleaseManifest } from "./release-manifest-v2.ts";
import {
  validateDesktopReleaseManifest,
  type DesktopReleaseManifest,
} from "./desktop-release-manifest.ts";
function signedJson(bytes: Uint8Array, signature: Uint8Array, pin: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(signature).trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(text)) throw new Error("Malformed desktop release signature.");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pin, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, bytes, key, Buffer.from(text, "base64url")))
    throw new Error("Release signature does not match the pinned public key.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function verifyDesktopReleaseBytes(
  bytes: Uint8Array,
  signature: Uint8Array,
  primaryBytes: Uint8Array,
  primarySignature: Uint8Array,
  publicKey = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
): DesktopReleaseManifest {
  const primary = signedJson(primaryBytes, primarySignature, publicKey);
  validateForkReleaseManifest(primary);
  const manifest = signedJson(bytes, signature, publicKey);
  validateDesktopReleaseManifest(manifest, primary);
  if (manifest.primaryManifestSha256 !== createHash("sha256").update(primaryBytes).digest("hex"))
    throw new Error("Desktop inventory belongs to different primary bytes.");
  return manifest;
}
