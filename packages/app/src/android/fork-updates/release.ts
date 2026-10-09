import nacl from "tweetnacl";
import {
  PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
  validatePaseoReleaseManifest,
  type PaseoReleaseManifest,
} from "@getpaseo/protocol/release-manifest";

export const FORK_REPOSITORY = "iExalt/paseo";
export const FORK_PACKAGE_ID = "sh.paseo.iexalt";
export const FORK_SIGNING_CERTIFICATE_SHA256 =
  "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459";
export const RELEASE_MANIFEST_NAME = "paseo-release-manifest.json";
export const RELEASE_SIGNATURE_NAME = "paseo-release-manifest.sig";
export const MAX_RELEASE_METADATA_BYTES = 256 * 1024;
export const MAX_APK_BYTES = 250 * 1024 * 1024;

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
  manifest: PaseoReleaseManifest;
  apkUrl: string;
  manifestText: string;
  signatureText: string;
}

export function releaseSequenceFromTag(tag: string): number | null {
  const match = /^paseo-fork-v\d+\.\d+\.\d+(?:-beta\.\d+)?-r([1-9][0-9]*)-[a-f0-9]{40}$/.exec(tag);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export async function findHighestVerifiedForkRelease<T>(
  releases: readonly GitHubRelease[],
  verifyCandidate: (release: GitHubRelease) => Promise<T | null>,
): Promise<{ release: GitHubRelease; verified: T }> {
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ release, sequence: releaseSequenceFromTag(release.tag_name) }))
    .filter(
      (candidate): candidate is { release: GitHubRelease; sequence: number } =>
        candidate.sequence !== null,
    )
    .sort((left, right) => right.sequence - left.sequence);
  const seenSequences = new Set<number>();
  for (const candidate of candidates) {
    if (seenSequences.has(candidate.sequence)) {
      throw new Error("Published Paseo fork releases have a duplicate sequence.");
    }
    seenSequences.add(candidate.sequence);
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
): PaseoReleaseManifest {
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
    validatePaseoReleaseManifest(value);
  } catch {
    throw new Error("Signed release manifest is invalid.");
  }
  return value;
}

export function verifyReleaseBinding(
  release: GitHubRelease,
  manifest: PaseoReleaseManifest,
  manifestText = "",
  signatureText = "",
): VerifiedForkUpdate {
  if (release.draft || release.prerelease)
    throw new Error("This fork release is not published and stable.");
  const sequence = releaseSequenceFromTag(release.tag_name);
  if (sequence === null || manifest.releaseTag !== release.tag_name) {
    throw new Error("Release tag does not match the signed manifest.");
  }
  assertApprovedForkManifest(manifest);
  if (manifest.releaseSequence !== sequence)
    throw new Error("Release sequence does not match its tag.");

  const apkAssets = release.assets.filter((asset) => asset.name === manifest.android.apk.name);
  if (
    apkAssets.length !== 1 ||
    apkAssets[0].size !== manifest.android.apk.bytes ||
    manifest.android.apk.bytes > MAX_APK_BYTES
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
  )}/${encodeURIComponent(manifest.android.apk.name)}`;
  return { manifest, apkUrl, manifestText, signatureText };
}

export function assertApprovedForkManifest(manifest: PaseoReleaseManifest): void {
  const sequence = releaseSequenceFromTag(manifest.releaseTag);
  if (
    sequence === null ||
    manifest.releaseSequence !== sequence ||
    manifest.android.packageId !== FORK_PACKAGE_ID ||
    manifest.android.versionCode !== sequence ||
    manifest.android.signingCertificateSha256 !== FORK_SIGNING_CERTIFICATE_SHA256 ||
    manifest.android.apk.bytes > MAX_APK_BYTES
  ) {
    throw new Error("Release identity does not match the approved Paseo fork.");
  }
}

export function isNewerThanInstalled(
  update: VerifiedForkUpdate,
  installedVersionCode: number,
  lastInstalledSequence: number,
): boolean {
  const { releaseSequence, android } = update.manifest;
  return (
    Number.isSafeInteger(installedVersionCode) &&
    Number.isSafeInteger(lastInstalledSequence) &&
    releaseSequence > installedVersionCode &&
    releaseSequence > lastInstalledSequence &&
    android.versionCode === releaseSequence
  );
}
