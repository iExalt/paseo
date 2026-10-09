import AsyncStorage from "@react-native-async-storage/async-storage";
import { requireOptionalNativeModule } from "expo-modules-core";
import {
  FORK_REPOSITORY,
  RELEASE_MANIFEST_NAME,
  RELEASE_SIGNATURE_NAME,
  MAX_RELEASE_METADATA_BYTES,
  assertApprovedForkManifest,
  findHighestVerifiedForkRelease,
  isNewerThanInstalled,
  verifyReleaseBinding,
  verifySignedManifest,
  type GitHubRelease,
  type VerifiedForkUpdate,
} from "./release";

const RELEASES_URL = `https://api.github.com/repos/${FORK_REPOSITORY}/releases`;
const INSTALLED_SEQUENCE_KEY = "@getpaseo/fork-update/installed-sequence";
const STAGED_UPDATE_KEY = "@getpaseo/fork-update/staged";
const PENDING_STAGED_UPDATE_KEY = "@getpaseo/fork-update/staged-pending";
const MAX_RELEASE_PAGES = 10;
const MAX_RELEASE_LIST_BYTES = 1_048_576;

function stagedApkFileName(update: VerifiedForkUpdate): string {
  return `fork-r${update.manifest.releaseSequence}-${update.manifest.android.apk.name}`;
}

interface ForkUpdatesNativeModule {
  getInstalledVersionCode(): number;
  canInstallUnknownApps(): boolean;
  openUnknownSourcesSettings(): Promise<void>;
  fetchText(url: string, maxBytes: number): Promise<string>;
  downloadAndVerifyApk(
    url: string,
    fileName: string,
    expectedBytes: number,
    expectedSha256: string,
    expectedPackage: string,
    expectedVersionCode: number,
    expectedCertificateSha256: string,
  ): Promise<string>;
  openInstaller(
    path: string,
    expectedBytes: number,
    expectedSha256: string,
    expectedPackage: string,
    expectedVersionCode: number,
    expectedCertificateSha256: string,
  ): Promise<void>;
  findVerifiedStagedApk(
    fileName: string,
    expectedBytes: number,
    expectedSha256: string,
    expectedPackage: string,
    expectedVersionCode: number,
    expectedCertificateSha256: string,
  ): Promise<string | null>;
  addListener(
    eventName: "onDownloadProgress",
    listener: (event: { downloadedBytes: number; totalBytes: number }) => void,
  ): { remove(): void };
}

export const forkUpdatesNative =
  requireOptionalNativeModule<ForkUpdatesNativeModule>("PaseoForkUpdates");

function parseReleaseList(value: unknown): GitHubRelease[] {
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid release list.");
  return value as GitHubRelease[];
}

async function readStableReleases(): Promise<GitHubRelease[]> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  const releases: GitHubRelease[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const body = await forkUpdatesNative.fetchText(
      `${RELEASES_URL}?per_page=100&page=${page}`,
      MAX_RELEASE_LIST_BYTES,
    );
    const batch = parseReleaseList(JSON.parse(body));
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("The fork release list exceeded the safe lookup limit.");
}

function releaseAssetUrl(tag: string, name: string): string {
  return `https://github.com/${FORK_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export async function checkForForkUpdate(): Promise<{
  update: VerifiedForkUpdate | null;
  installedVersionCode: number;
}> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  const [releases, installedVersionCode, storedSequenceText] = await Promise.all([
    readStableReleases(),
    Promise.resolve(forkUpdatesNative.getInstalledVersionCode()),
    AsyncStorage.getItem(INSTALLED_SEQUENCE_KEY),
  ]);
  const { verified } = await findHighestVerifiedForkRelease(releases, async (release) => {
    const manifestAssets = release.assets.filter((asset) => asset.name === RELEASE_MANIFEST_NAME);
    const signatureAssets = release.assets.filter((asset) => asset.name === RELEASE_SIGNATURE_NAME);
    if (manifestAssets.length !== 1 || signatureAssets.length !== 1) return null;
    const [manifestAsset] = manifestAssets;
    const [signatureAsset] = signatureAssets;
    if (
      manifestAsset.size <= 0 ||
      manifestAsset.size > MAX_RELEASE_METADATA_BYTES ||
      signatureAsset.size <= 0 ||
      signatureAsset.size > 1024
    ) {
      return null;
    }
    const [manifestText, signatureText] = await Promise.all([
      forkUpdatesNative.fetchText(
        releaseAssetUrl(release.tag_name, RELEASE_MANIFEST_NAME),
        MAX_RELEASE_METADATA_BYTES,
      ),
      forkUpdatesNative.fetchText(releaseAssetUrl(release.tag_name, RELEASE_SIGNATURE_NAME), 1024),
    ]);
    const manifestBytes = new TextEncoder().encode(manifestText);
    if (manifestBytes.byteLength !== manifestAsset.size) return null;
    try {
      return verifyReleaseBinding(
        release,
        verifySignedManifest(manifestBytes, signatureText),
        manifestText,
        signatureText,
      );
    } catch {
      return null;
    }
  });
  const storedSequence =
    storedSequenceText && /^[1-9][0-9]*$/.test(storedSequenceText) ? Number(storedSequenceText) : 0;
  if (!Number.isSafeInteger(storedSequence)) {
    throw new Error("The installed fork update sequence is invalid.");
  }
  const update = isNewerThanInstalled(verified, installedVersionCode, storedSequence)
    ? verified
    : null;
  if (!update) await clearStagedForkUpdate();
  return {
    update,
    installedVersionCode,
  };
}

export async function downloadForkUpdate(update: VerifiedForkUpdate): Promise<string> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  const { manifest, apkUrl } = update;
  const receipt = JSON.stringify({
    manifestText: update.manifestText,
    signatureText: update.signatureText,
  });
  await AsyncStorage.setItem(PENDING_STAGED_UPDATE_KEY, receipt);
  let path: string;
  try {
    path = await forkUpdatesNative.downloadAndVerifyApk(
      apkUrl,
      stagedApkFileName(update),
      manifest.android.apk.bytes,
      manifest.android.apk.sha256,
      manifest.android.packageId,
      manifest.android.versionCode,
      manifest.android.signingCertificateSha256,
    );
  } catch (error) {
    await AsyncStorage.removeItem(PENDING_STAGED_UPDATE_KEY);
    throw error;
  }
  await AsyncStorage.setItem(STAGED_UPDATE_KEY, receipt);
  await AsyncStorage.removeItem(PENDING_STAGED_UPDATE_KEY);
  return path;
}

export async function restoreStagedForkUpdate(): Promise<{
  update: VerifiedForkUpdate;
  path: string;
  installedVersionCode: number;
} | null> {
  if (!forkUpdatesNative) return null;
  const installedVersionCode = forkUpdatesNative.getInstalledVersionCode();
  const installedSequenceText = await AsyncStorage.getItem(INSTALLED_SEQUENCE_KEY);
  const installedSequence =
    installedSequenceText && /^[1-9][0-9]*$/.test(installedSequenceText)
      ? Number(installedSequenceText)
      : 0;
  if (!Number.isSafeInteger(installedSequence)) {
    throw new Error("The installed fork update sequence is invalid.");
  }

  for (const key of [PENDING_STAGED_UPDATE_KEY, STAGED_UPDATE_KEY]) {
    const receiptText = await AsyncStorage.getItem(key);
    if (!receiptText) continue;
    if (receiptText.length > MAX_RELEASE_METADATA_BYTES + 2048) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    let update: VerifiedForkUpdate;
    try {
      const receipt = JSON.parse(receiptText) as {
        manifestText?: unknown;
        signatureText?: unknown;
      };
      if (typeof receipt.manifestText !== "string" || typeof receipt.signatureText !== "string") {
        throw new Error("Staged update metadata is malformed.");
      }
      const manifestBytes = new TextEncoder().encode(receipt.manifestText);
      const manifest = verifySignedManifest(manifestBytes, receipt.signatureText);
      assertApprovedForkManifest(manifest);
      update = {
        manifest,
        manifestText: receipt.manifestText,
        signatureText: receipt.signatureText,
        apkUrl: `https://github.com/${FORK_REPOSITORY}/releases/download/${encodeURIComponent(
          manifest.releaseTag,
        )}/${encodeURIComponent(manifest.android.apk.name)}`,
      };
    } catch {
      await AsyncStorage.removeItem(key);
      continue;
    }

    if (
      installedVersionCode === update.manifest.android.versionCode &&
      update.manifest.releaseSequence > installedSequence
    ) {
      await AsyncStorage.setItem(INSTALLED_SEQUENCE_KEY, String(update.manifest.releaseSequence));
      await clearStagedForkUpdate();
      return null;
    }
    if (!isNewerThanInstalled(update, installedVersionCode, installedSequence)) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    const path = await forkUpdatesNative.findVerifiedStagedApk(
      stagedApkFileName(update),
      update.manifest.android.apk.bytes,
      update.manifest.android.apk.sha256,
      update.manifest.android.packageId,
      update.manifest.android.versionCode,
      update.manifest.android.signingCertificateSha256,
    );
    if (!path) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    if (key === PENDING_STAGED_UPDATE_KEY) {
      await AsyncStorage.setItem(STAGED_UPDATE_KEY, receiptText);
      await AsyncStorage.removeItem(PENDING_STAGED_UPDATE_KEY);
    }
    return { update, path, installedVersionCode };
  }
  return null;
}

export async function canInstallForkUpdate(): Promise<boolean> {
  return forkUpdatesNative?.canInstallUnknownApps() ?? false;
}

export async function openForkUpdateInstallSettings(): Promise<void> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  await forkUpdatesNative.openUnknownSourcesSettings();
}

export async function launchForkUpdateInstaller(
  update: VerifiedForkUpdate,
  path: string,
): Promise<void> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  await forkUpdatesNative.openInstaller(
    path,
    update.manifest.android.apk.bytes,
    update.manifest.android.apk.sha256,
    update.manifest.android.packageId,
    update.manifest.android.versionCode,
    update.manifest.android.signingCertificateSha256,
  );
}

export async function recordInstalledForkUpdate(sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Installed fork sequence is invalid.");
  }
  await AsyncStorage.setItem(INSTALLED_SEQUENCE_KEY, String(sequence));
  await clearStagedForkUpdate();
}

export async function clearStagedForkUpdate(): Promise<void> {
  await AsyncStorage.multiRemove([STAGED_UPDATE_KEY, PENDING_STAGED_UPDATE_KEY]);
}
