/** Portable signed release inventory. Verify the original bytes before parsing. */
import { forkAndroidVersionCode, forkReleaseTag, parseForkVersion } from "./fork-version.ts";
import { PASEO_RELEASE_MANIFEST_KEY_ID } from "./release-manifest.ts";
import type { ReleaseManifestAsset } from "./release-manifest.ts";

export const FORK_RELEASE_REPOSITORY = "iExalt/paseo";
export const FORK_RELEASE_LINEAGE = "iExalt/paseo:semver-v1";
export const FORK_ANDROID_PACKAGE_ID = "sh.paseo.iexalt";
export const FORK_ANDROID_CERTIFICATE_SHA256 =
  "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459";

interface ArtifactIdentity {
  platform: "macos" | "linux" | "android" | "windows";
  arch: "arm64" | "x64";
}
export type ForkReleaseArtifact = ReleaseManifestAsset &
  ArtifactIdentity &
  (
    | { kind: "deb" | "rpm" | "appimage" | "nsis" }
    | {
        kind: "nix-desktop" | "nix-daemon";
        system: "aarch64-darwin" | "aarch64-linux" | "x86_64-linux";
        outputPath: string;
        closureManifest: ReleaseManifestAsset;
      }
    | {
        kind: "apk";
        abi: "arm64-v8a";
        packageId: typeof FORK_ANDROID_PACKAGE_ID;
        versionCode: number;
        signingCertificateSha256: typeof FORK_ANDROID_CERTIFICATE_SHA256;
      }
  );

export interface ForkReleaseManifest {
  schemaVersion: 2;
  keyId: typeof PASEO_RELEASE_MANIFEST_KEY_ID;
  repository: typeof FORK_RELEASE_REPOSITORY;
  lineage: typeof FORK_RELEASE_LINEAGE;
  version: string;
  sourceSha: string;
  upstreamBase: string;
  releaseTag: string;
  artifacts: ForkReleaseArtifact[];
}

const cells = new Set(["macos/arm64/nix-desktop", "android/arm64/apk"]);
for (const arch of ["x64", "arm64"]) {
  for (const kind of ["nix-daemon", "nix-desktop", "deb", "rpm", "appimage"]) {
    cells.add(`linux/${arch}/${kind}`);
  }
  cells.add(`windows/${arch}/nsis`);
}
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const assetKeys = ["name", "bytes", "sha256"];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Release metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Release metadata has missing or unsupported fields.");
  }
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function asset(value: Record<string, unknown>, names: Set<string>): void {
  // Portable leaf names also rule out URL fragments, encoded traversal, device
  // names, and Windows case-insensitive aliases in downloaded release assets.
  if (
    !matches(value.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) ||
    value.name.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.name)
  ) {
    throw new Error("Release asset must have a portable leaf filename.");
  }
  const name = value.name.toLowerCase();
  if (names.has(name)) throw new Error("Duplicate release asset filename.");
  names.add(name);
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !matches(value.sha256, digestPattern)
  ) {
    throw new Error("Release asset byte count or SHA-256 is invalid.");
  }
}

export function validateForkReleaseManifest(value: unknown): asserts value is ForkReleaseManifest {
  const manifest = object(value);
  exactKeys(manifest, [
    "schemaVersion",
    "keyId",
    "repository",
    "lineage",
    "version",
    "sourceSha",
    "upstreamBase",
    "releaseTag",
    "artifacts",
  ]);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.keyId !== PASEO_RELEASE_MANIFEST_KEY_ID ||
    manifest.repository !== FORK_RELEASE_REPOSITORY ||
    manifest.lineage !== FORK_RELEASE_LINEAGE
  )
    throw new Error("Unsupported release schema, key, repository, or lineage.");
  parseForkVersion(manifest.version);
  const version = manifest.version as string;
  if (
    manifest.releaseTag !== forkReleaseTag(version) ||
    !matches(manifest.sourceSha, commitPattern) ||
    !matches(manifest.upstreamBase, commitPattern)
  )
    throw new Error("Invalid fork release tag or source identity.");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== cells.size) {
    throw new Error("Release inventory must contain the complete artifact matrix.");
  }
  const remaining = new Set(cells);
  const names = new Set<string>();
  for (const entry of manifest.artifacts) {
    const artifact = object(entry);
    const cell = `${artifact.platform}/${artifact.arch}/${artifact.kind}`;
    if (!remaining.delete(cell)) throw new Error("Unknown or duplicate release artifact cell.");
    validateArtifactMetadata(artifact, version, names);
    asset(artifact, names);
  }
}

function validateArtifactMetadata(
  artifact: Record<string, unknown>,
  version: string,
  names: Set<string>,
): void {
  const keys = [...assetKeys, "platform", "arch", "kind"];
  if (artifact.kind === "apk") {
    exactKeys(artifact, [...keys, "abi", "packageId", "versionCode", "signingCertificateSha256"]);
    if (
      artifact.abi !== "arm64-v8a" ||
      artifact.packageId !== FORK_ANDROID_PACKAGE_ID ||
      artifact.signingCertificateSha256 !== FORK_ANDROID_CERTIFICATE_SHA256 ||
      artifact.versionCode !== forkAndroidVersionCode(version)
    )
      throw new Error(
        "Android release identity does not match the fork version and signing identity.",
      );
  } else if (artifact.kind === "nix-desktop" || artifact.kind === "nix-daemon") {
    exactKeys(artifact, [...keys, "system", "outputPath", "closureManifest"]);
    const linuxSystem = artifact.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
    const system = artifact.platform === "macos" ? "aarch64-darwin" : linuxSystem;
    const product = artifact.kind === "nix-desktop" ? "paseo-desktop" : "paseo";
    if (
      artifact.system !== system ||
      !matches(
        artifact.outputPath,
        new RegExp(
          `^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-${product}-${version.replaceAll(".", "\\.")}$`,
        ),
      )
    )
      throw new Error("Nix system or output path does not match its release artifact cell.");
    const closure = object(artifact.closureManifest);
    exactKeys(closure, assetKeys);
    asset(closure, names);
  } else {
    exactKeys(artifact, keys);
  }
}

/** For producers only; consumers verify original bytes, never this reserialization. */
export function serializeForkReleaseManifest(manifest: ForkReleaseManifest): string {
  validateForkReleaseManifest(manifest);
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sorted(item)]),
      );
    }
    return value;
  }
  return `${JSON.stringify(sorted(manifest))}\n`;
}
