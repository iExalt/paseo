import nacl from "tweetnacl";
import { PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL } from "@getpaseo/protocol/release-manifest";

import {
  validateForkReleaseManifest,
  FORK_RELEASE_REPOSITORY as FORK_REPOSITORY,
  type ForkReleaseManifest,
  type ForkReleaseArtifact,
} from "@getpaseo/protocol/release-manifest-v2";
import { compareForkVersions, forkVersionFromTag } from "@getpaseo/protocol/fork-version";
export { FORK_REPOSITORY };
export {
  FORK_ANDROID_PACKAGE_ID as FORK_PACKAGE_ID,
  FORK_ANDROID_CERTIFICATE_SHA256 as FORK_SIGNING_CERTIFICATE_SHA256,
} from "@getpaseo/protocol/release-manifest-v2";
export const RELEASE_MANIFEST_NAME = "paseo-release-manifest.json";
export const RELEASE_SIGNATURE_NAME = "paseo-release-manifest.sig";
export const MAX_RELEASE_METADATA_BYTES = 256 * 1024;
export const MAX_APK_BYTES = 250 * 1024 * 1024;
export const GZIP_SUFFIX = ".gz";
const DELTA_SIDECAR = /^\.delta-from-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.zst$/;

export function isForkAndroidUpdaterEnabled(
  platform: string,
  forkUpdatesEnabled: unknown,
  nativeModuleAvailable: boolean,
): boolean {
  return platform === "android" && forkUpdatesEnabled === true && nativeModuleAvailable;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface VerifiedForkUpdate {
  manifest: ForkReleaseManifest;
  android: Extract<ForkReleaseArtifact, { kind: "apk" }>;
  apkUrl: string;
  // Byte count of the unsigned `<apk>.gz` sidecar when the release has a usable one.
  gzipApkBytes?: number;
  // Byte counts of the unsigned `<apk>.delta-from-<version>.zst` sidecars, by base version.
  apkDeltaBytes?: Record<string, number>;
  manifestText: string;
  signatureText: string;
}

export function releaseVersionFromTag(tag: string): string | null {
  return forkVersionFromTag(tag);
}

export async function findHighestVerifiedForkRelease<T>(
  releases: readonly GitHubRelease[],
  verifyCandidate: (release: GitHubRelease) => Promise<T | null>,
): Promise<{ release: GitHubRelease; verified: T }> {
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ release, version: releaseVersionFromTag(release.tag_name) }))
    .filter(
      (candidate): candidate is { release: GitHubRelease; version: string } =>
        candidate.version !== null,
    )
    .sort((left, right) => compareForkVersions(right.version, left.version));
  const seenVersions = new Set<string>();
  for (const candidate of candidates) {
    if (seenVersions.has(candidate.version)) {
      throw new Error("Published Paseo fork releases have a duplicate version.");
    }
    seenVersions.add(candidate.version);
    const verified = await verifyCandidate(candidate.release);
    if (verified !== null) return { release: candidate.release, verified };
  }
  throw new Error("No signed published Paseo fork release could be verified.");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Release signature encoding is invalid.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = globalThis.atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function verifySignedManifest(
  manifestBytes: Uint8Array,
  signatureText: string,
  publicKeyBase64Url = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
): ForkReleaseManifest {
  const signatureValue = signatureText.trim();
  const signature = decodeBase64Url(signatureValue);
  const publicKey = decodeBase64Url(publicKeyBase64Url);
  if (
    signature.length !== nacl.sign.signatureLength ||
    publicKey.length !== nacl.sign.publicKeyLength
  ) {
    throw new Error("Release signature or public key has an invalid length.");
  }
  if (!nacl.sign.detached.verify(manifestBytes, signature, publicKey)) {
    throw new Error("Release manifest signature is invalid.");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(manifestBytes));
    validateForkReleaseManifest(value);
  } catch {
    throw new Error("Signed release manifest is invalid.");
  }
  return value;
}

export function verifyReleaseBinding(
  release: GitHubRelease,
  manifest: ForkReleaseManifest,
  manifestText = "",
  signatureText = "",
): VerifiedForkUpdate {
  if (release.draft || release.prerelease)
    throw new Error("This fork release is not published and stable.");
  const version = releaseVersionFromTag(release.tag_name);
  if (version === null || manifest.releaseTag !== release.tag_name) {
    throw new Error("Release tag does not match the signed manifest.");
  }
  const android = approvedAndroidArtifact(manifest);

  const apkAssets = release.assets.filter((asset) => asset.name === android.name);
  if (
    apkAssets.length !== 1 ||
    apkAssets[0].size !== android.bytes ||
    android.bytes > MAX_APK_BYTES
  ) {
    throw new Error("The signed APK asset is missing or has an unexpected size.");
  }
  for (const expectedName of [RELEASE_MANIFEST_NAME, RELEASE_SIGNATURE_NAME]) {
    if (release.assets.filter((asset) => asset.name === expectedName).length !== 1) {
      throw new Error("Release signature assets are missing or duplicated.");
    }
  }

  const apkUrl = `https://github.com/${FORK_REPOSITORY}/releases/download/${encodeURIComponent(
    release.tag_name,
  )}/${encodeURIComponent(android.name)}`;
  const gzipApkBytes = gzipApkSidecarBytes(release.assets, android);
  const apkDeltaBytes = apkDeltaSidecarBytes(release.assets, android);
  return {
    manifest,
    android,
    apkUrl,
    ...(gzipApkBytes === null ? {} : { gzipApkBytes }),
    ...(Object.keys(apkDeltaBytes).length === 0 ? {} : { apkDeltaBytes }),
    manifestText,
    signatureText,
  };
}

// The `.gz` sidecar is unsigned: the device gunzips it and checks the result against the
// signed APK bytes, hash and signer, falling back to the APK. Its listed size only has to
// be plausible, since a gzip that fails to shrink the APK is not worth downloading.
export function gzipApkSidecarBytes(
  assets: readonly GitHubReleaseAsset[],
  android: Pick<ForkReleaseArtifact, "name" | "bytes">,
): number | null {
  const sidecars = assets.filter((asset) => asset.name === `${android.name}${GZIP_SUFFIX}`);
  if (sidecars.length !== 1) return null;
  const { size } = sidecars[0];
  return Number.isSafeInteger(size) && size > 0 && size < android.bytes ? size : null;
}

// Delta sidecars are unsigned too: the device applies the one made from its installed
// release to the installed APK and checks the result like the gzip one, falling back to it.
export function apkDeltaSidecarBytes(
  assets: readonly GitHubReleaseAsset[],
  android: Pick<ForkReleaseArtifact, "name" | "bytes">,
): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const { name, size } of assets) {
    if (!name.startsWith(android.name)) continue;
    const baseVersion = DELTA_SIDECAR.exec(name.slice(android.name.length))?.[1];
    if (baseVersion && Number.isSafeInteger(size) && size > 0 && size < android.bytes) {
      deltas[baseVersion] = size;
    }
  }
  return deltas;
}

export function approvedAndroidArtifact(
  manifest: ForkReleaseManifest,
): Extract<ForkReleaseArtifact, { kind: "apk" }> {
  validateForkReleaseManifest(manifest);
  const android = manifest.artifacts.find((artifact) => artifact.kind === "apk");
  if (!android || android.kind !== "apk" || android.bytes > MAX_APK_BYTES) {
    throw new Error("Release identity does not match the approved Paseo fork.");
  }
  return android;
}

export function isNewerThanInstalled(
  update: VerifiedForkUpdate,
  installedVersion: string,
  highWaterVersion: string,
): boolean {
  return (
    compareForkVersions(update.manifest.version, installedVersion) > 0 &&
    compareForkVersions(update.manifest.version, highWaterVersion) > 0
  );
}
