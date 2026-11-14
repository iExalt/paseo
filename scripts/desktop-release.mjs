import assert from "node:assert/strict";
import {
  DESKTOP_MANIFEST_ASSET,
  DESKTOP_SIGNATURE_ASSET,
} from "../packages/protocol/src/desktop-release-manifest.ts";
import { verifyDesktopReleaseBytes } from "../packages/protocol/src/desktop-release-verifier.ts";
import { resolveLatestTag, fetchMetadata, releaseDownloadUrl } from "./paseo-nix-update.mjs";
import { discoverVerifiedForkRelease } from "../packages/protocol/src/fork-release-discovery.ts";
export { DESKTOP_MANIFEST_ASSET, DESKTOP_SIGNATURE_ASSET, verifyDesktopReleaseBytes };
export async function latestVerifiedDesktopRelease({
  resolveTag = resolveLatestTag,
  fetchBytes = fetchMetadata,
  publicKey,
} = {}) {
  return discoverVerifiedForkRelease({
    resolveTag,
    fetchBytes,
    verifyTag: (tag) => verifiedDesktopReleaseForTag(tag, { fetchBytes, publicKey }),
  });
}
export async function verifiedDesktopReleaseForTag(
  tag,
  { fetchBytes = fetchMetadata, publicKey } = {},
) {
  const [manifestBytes, signatureBytes, primaryBytes, primarySignature] = await Promise.all(
    [
      DESKTOP_MANIFEST_ASSET,
      DESKTOP_SIGNATURE_ASSET,
      "paseo-release-manifest.json",
      "paseo-release-manifest.sig",
    ].map((name) => fetchBytes(releaseDownloadUrl(tag, name), name)),
  );
  const manifest = verifyDesktopReleaseBytes(
    manifestBytes,
    signatureBytes,
    primaryBytes,
    primarySignature,
    publicKey,
  );
  assert.equal(manifest.releaseTag, tag, "Desktop inventory names another release");
  return { tag, manifest, manifestBytes, signatureBytes, primaryBytes, primarySignature };
}
