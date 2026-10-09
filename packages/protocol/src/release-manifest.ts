/**
 * Portable contract for externally signed fork release metadata.
 *
 * This module deliberately has no Node, React Native, or cryptography imports.
 * Producers sign the serialized bytes with their platform crypto adapter;
 * consumers verify those same bytes against the independently pinned key below
 * before parsing and validating this schema.
 */

export const PASEO_RELEASE_MANIFEST_KEY_ID = "paseo-release-manifest-1";
export const PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL =
  "iseyxFToCZaOyBoHEsfbC6XN4t5eTJRbc6Qy-AQK8xc";

export interface ReleaseManifestAsset {
  name: string;
  bytes: number;
  sha256: string;
}

export interface PaseoReleaseManifest {
  schemaVersion: 1;
  keyId: typeof PASEO_RELEASE_MANIFEST_KEY_ID;
  channel: "fork";
  releaseTag: string;
  sourceSha: string;
  runId: string;
  runAttempt: number;
  releaseSequence: number;
  packageVersion: string;
  promotionToolSha: string;
  createdAt: string;
  macOS: {
    system: "aarch64-darwin";
    outputPath: string;
    closureArchive: ReleaseManifestAsset;
    closureManifest: ReleaseManifestAsset;
  };
  android: {
    abi: "arm64-v8a";
    packageId: "sh.paseo.iexalt";
    versionCode: number;
    signingCertificateSha256: string;
    apk: ReleaseManifestAsset;
    buildMetadata: ReleaseManifestAsset;
  };
  rollbackOf: {
    releaseTag: string;
    sourceSha: string;
    releaseSequence: number;
    androidVersionCode: number;
  } | null;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const sourceShaPattern = /^[a-f0-9]{40}$/;
const safePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function expectObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has missing or unsupported fields.`);
  }
}

function expectString(value: unknown, name: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is invalid.`);
  }
}

function validateAsset(value: unknown, name: string): asserts value is ReleaseManifestAsset {
  const asset = expectObject(value, name);
  expectExactKeys(asset, ["name", "bytes", "sha256"], name);
  expectString(asset.name, `${name}.name`);
  if (
    asset.name.includes("/") ||
    asset.name.includes("\\") ||
    asset.name === "." ||
    asset.name === ".."
  ) {
    throw new Error(`${name}.name must be a leaf filename.`);
  }
  if (!safePositiveInteger(asset.bytes)) {
    throw new Error(`${name}.bytes must be a positive safe integer.`);
  }
  expectString(asset.sha256, `${name}.sha256`, sha256Pattern);
}

export function validatePaseoReleaseManifest(
  value: unknown,
): asserts value is PaseoReleaseManifest {
  const manifest = expectObject(value, "Release manifest");
  expectExactKeys(
    manifest,
    [
      "schemaVersion",
      "keyId",
      "channel",
      "releaseTag",
      "sourceSha",
      "runId",
      "runAttempt",
      "releaseSequence",
      "packageVersion",
      "promotionToolSha",
      "createdAt",
      "macOS",
      "android",
      "rollbackOf",
    ],
    "Release manifest",
  );

  if (
    manifest.schemaVersion !== 1 ||
    manifest.keyId !== PASEO_RELEASE_MANIFEST_KEY_ID ||
    manifest.channel !== "fork"
  ) {
    throw new Error("Release manifest schema, key, or channel is unsupported.");
  }
  expectString(manifest.releaseTag, "releaseTag", /^paseo-fork-v\S+$/);
  expectString(manifest.sourceSha, "sourceSha", sourceShaPattern);
  expectString(manifest.runId, "runId", /^[1-9][0-9]*$/);
  if (!safePositiveInteger(manifest.runAttempt) || !safePositiveInteger(manifest.releaseSequence)) {
    throw new Error("Release attempt and sequence must be positive safe integers.");
  }
  expectString(manifest.packageVersion, "packageVersion", /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  expectString(manifest.promotionToolSha, "promotionToolSha", sourceShaPattern);
  if (
    manifest.releaseTag !==
    `paseo-fork-v${manifest.packageVersion}-r${manifest.releaseSequence}-${manifest.sourceSha}`
  ) {
    throw new Error("releaseTag does not match this release identity.");
  }
  expectString(manifest.createdAt, "createdAt", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("createdAt must be a valid UTC timestamp.");
  }

  const macOS = expectObject(manifest.macOS, "macOS");
  expectExactKeys(macOS, ["system", "outputPath", "closureArchive", "closureManifest"], "macOS");
  if (macOS.system !== "aarch64-darwin") {
    throw new Error("macOS system is unsupported.");
  }
  expectString(
    macOS.outputPath,
    "macOS.outputPath",
    /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/,
  );
  validateAsset(macOS.closureArchive, "macOS.closureArchive");
  validateAsset(macOS.closureManifest, "macOS.closureManifest");

  const android = expectObject(manifest.android, "android");
  expectExactKeys(
    android,
    ["abi", "packageId", "versionCode", "signingCertificateSha256", "apk", "buildMetadata"],
    "android",
  );
  if (android.abi !== "arm64-v8a" || android.packageId !== "sh.paseo.iexalt") {
    throw new Error("Android package or ABI is unsupported.");
  }
  if (!safePositiveInteger(android.versionCode) || android.versionCode > 2_100_000_000) {
    throw new Error("Android version code is invalid.");
  }
  if (android.versionCode !== manifest.releaseSequence) {
    throw new Error("Android version code must match the paired release sequence.");
  }
  expectString(android.signingCertificateSha256, "android.signingCertificateSha256", sha256Pattern);
  validateAsset(android.apk, "android.apk");
  validateAsset(android.buildMetadata, "android.buildMetadata");

  if (manifest.rollbackOf !== null) {
    const rollback = expectObject(manifest.rollbackOf, "rollbackOf");
    expectExactKeys(
      rollback,
      ["releaseTag", "sourceSha", "releaseSequence", "androidVersionCode"],
      "rollbackOf",
    );
    expectString(rollback.releaseTag, "rollbackOf.releaseTag", /^paseo-fork-v\S+$/);
    expectString(rollback.sourceSha, "rollbackOf.sourceSha", sourceShaPattern);
    if (
      !safePositiveInteger(rollback.releaseSequence) ||
      !safePositiveInteger(rollback.androidVersionCode)
    ) {
      throw new Error("rollbackOf sequence and version code must be positive safe integers.");
    }
    if (
      rollback.releaseSequence >= manifest.releaseSequence ||
      rollback.androidVersionCode >= android.versionCode
    ) {
      throw new Error("rollbackOf must refer to a strictly older release identity.");
    }
  }
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonKeys(entry)]),
    );
  }
  return value;
}

/** Serialize one validated manifest deterministically for detached signing. */
export function serializePaseoReleaseManifest(manifest: PaseoReleaseManifest): string {
  validatePaseoReleaseManifest(manifest);
  return `${JSON.stringify(sortJsonKeys(manifest))}\n`;
}
