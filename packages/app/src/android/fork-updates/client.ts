import {
  compareForkVersions,
  forkAndroidVersionCode,
  parseForkVersion,
} from "@getpaseo/protocol/fork-version";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { requireOptionalNativeModule } from "expo-modules-core";
import {
  FORK_REPOSITORY,
  RELEASE_MANIFEST_NAME,
  RELEASE_SIGNATURE_NAME,
  MAX_RELEASE_METADATA_BYTES,
  approvedAndroidArtifact,
  findHighestVerifiedForkRelease,
  isNewerThanInstalled,
  verifyReleaseBinding,
  verifySignedManifest,
  type GitHubRelease,
  type VerifiedForkUpdate,
} from "./release";

const RELEASES_URL = `https://api.github.com/repos/${FORK_REPOSITORY}/releases`;
// Historical keys are retained for manual recovery, never interpreted as fork semver.
const HIGH_WATER_VERSION_KEY = "@getpaseo/fork-update/semver-v1/high-water";
const STAGED_UPDATE_KEY = "@getpaseo/fork-update/semver-v1/staged";
const PENDING_STAGED_UPDATE_KEY = "@getpaseo/fork-update/semver-v1/staged-pending";
const MAX_RELEASE_PAGES = 10;
const MAX_RELEASE_LIST_BYTES = 1_048_576;

function stagedApkFileName(update: VerifiedForkUpdate): string {
  return `fork-v${update.manifest.version}-${update.android.name}`;
}

interface ForkUpdatesNativeModule {
  getInstalledVersionCode(): number;
  getInstalledVersion(): string;
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
    expectedVersion: string,
    expectedCertificateSha256: string,
  ): Promise<string>;
  openInstaller(
    path: string,
    expectedBytes: number,
    expectedSha256: string,
    expectedPackage: string,
    expectedVersionCode: number,
    expectedVersion: string,
    expectedCertificateSha256: string,
  ): Promise<void>;
  findVerifiedStagedApk(
    fileName: string,
    expectedBytes: number,
    expectedSha256: string,
    expectedPackage: string,
    expectedVersionCode: number,
    expectedVersion: string,
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

export class ForkManualMigrationRequired extends Error {
  constructor() {
    super("Install the fork 0.1.0 or newer manually before using fork updates.");
  }
}

let installedStateQueue: Promise<unknown> = Promise.resolve();
async function readInstalledState(): Promise<{
  installedVersion: string;
  highWaterVersion: string;
}> {
  const operation = installedStateQueue.then(async () => {
    if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
    let installedVersion: string;
    try {
      installedVersion = forkUpdatesNative.getInstalledVersion();
      parseForkVersion(installedVersion);
      if (
        forkUpdatesNative.getInstalledVersionCode() !== forkAndroidVersionCode(installedVersion)
      ) {
        throw new Error("Installed build encoding does not match fork semver.");
      }
    } catch {
      throw new ForkManualMigrationRequired();
    }
    const stored = await AsyncStorage.getItem(HIGH_WATER_VERSION_KEY);
    if (stored !== null) parseForkVersion(stored);
    const highWaterVersion =
      stored !== null && compareForkVersions(stored, installedVersion) > 0
        ? stored
        : installedVersion;
    if (stored !== highWaterVersion)
      await AsyncStorage.setItem(HIGH_WATER_VERSION_KEY, highWaterVersion);
    return { installedVersion, highWaterVersion };
  });
  installedStateQueue = operation.catch(() => undefined);
  return operation;
}

function updateFromReceipt(manifestText: string, signatureText: string): VerifiedForkUpdate {
  const manifest = verifySignedManifest(new TextEncoder().encode(manifestText), signatureText);
  const android = approvedAndroidArtifact(manifest);
  return {
    manifest,
    android,
    manifestText,
    signatureText,
    apkUrl: releaseAssetUrl(manifest.releaseTag, android.name),
  };
}

async function requireNewerInstalledUpdate(
  update: VerifiedForkUpdate,
): Promise<VerifiedForkUpdate> {
  const verified = updateFromReceipt(update.manifestText, update.signatureText);
  const { installedVersion, highWaterVersion } = await readInstalledState();
  if (!isNewerThanInstalled(verified, installedVersion, highWaterVersion)) {
    throw new Error("Fork update is not newer than the installed high-water version.");
  }
  return verified;
}

export async function checkForForkUpdate(): Promise<{
  update: VerifiedForkUpdate | null;
  installedVersion: string;
}> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  const [{ installedVersion, highWaterVersion }, releases] = await Promise.all([
    readInstalledState(),
    readStableReleases(),
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
  const update = isNewerThanInstalled(verified, installedVersion, highWaterVersion)
    ? verified
    : null;
  if (!update) await clearStagedForkUpdate();
  return {
    update,
    installedVersion,
  };
}

export async function downloadForkUpdate(update: VerifiedForkUpdate): Promise<string> {
  if (!forkUpdatesNative) throw new Error("Fork updates are unavailable in this app build.");
  update = await requireNewerInstalledUpdate(update);
  const { android, apkUrl } = update;
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
      android.bytes,
      android.sha256,
      android.packageId,
      android.versionCode,
      update.manifest.version,
      android.signingCertificateSha256,
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
  installedVersion: string;
} | null> {
  if (!forkUpdatesNative) return null;
  const { installedVersion, highWaterVersion } = await readInstalledState();

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
      update = updateFromReceipt(receipt.manifestText, receipt.signatureText);
    } catch {
      await AsyncStorage.removeItem(key);
      continue;
    }

    if (!isNewerThanInstalled(update, installedVersion, highWaterVersion)) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    const path = await forkUpdatesNative.findVerifiedStagedApk(
      stagedApkFileName(update),
      update.android.bytes,
      update.android.sha256,
      update.android.packageId,
      update.android.versionCode,
      update.manifest.version,
      update.android.signingCertificateSha256,
    );
    if (!path) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    if (key === PENDING_STAGED_UPDATE_KEY) {
      await AsyncStorage.setItem(STAGED_UPDATE_KEY, receiptText);
      await AsyncStorage.removeItem(PENDING_STAGED_UPDATE_KEY);
    }
    return { update, path, installedVersion };
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
  update = await requireNewerInstalledUpdate(update);
  await forkUpdatesNative.openInstaller(
    path,
    update.android.bytes,
    update.android.sha256,
    update.android.packageId,
    update.android.versionCode,
    update.manifest.version,
    update.android.signingCertificateSha256,
  );
}

export async function recordInstalledForkUpdate(version: string): Promise<void> {
  const { installedVersion } = await readInstalledState();
  if (installedVersion !== version) throw new Error("The expected fork version is not installed.");
  await clearStagedForkUpdate();
}

export async function clearStagedForkUpdate(): Promise<void> {
  await AsyncStorage.multiRemove([STAGED_UPDATE_KEY, PENDING_STAGED_UPDATE_KEY]);
}
