/** Separate signed desktop inventory; existing Mac/Android manifest readers stay unchanged. */
import { validateForkReleaseManifest, type ForkReleaseManifest } from "./release-manifest-v2.ts";
import type { ReleaseManifestAsset } from "./release-manifest.ts";

export const DESKTOP_MANIFEST_ASSET = "paseo-desktop-manifest.json";
export const DESKTOP_SIGNATURE_ASSET = "paseo-desktop-manifest.sig";
export type DesktopReleaseArtifact = ReleaseManifestAsset &
  (
    | { platform: "windows"; arch: "x64"; kind: "nsis"; sha512: string }
    | {
        platform: "linux";
        arch: "x64" | "arm64";
        kind: "nix-desktop";
        system: "x86_64-linux" | "aarch64-linux";
        outputPath: string;
        outputPaths: [string, string];
        closureManifest: ReleaseManifestAsset;
      }
  );
export interface DesktopReleaseManifest {
  schemaVersion: 1;
  keyId: ForkReleaseManifest["keyId"];
  repository: ForkReleaseManifest["repository"];
  lineage: ForkReleaseManifest["lineage"];
  version: string;
  sourceSha: string;
  upstreamBase: string;
  releaseTag: string;
  primaryManifestSha256: string;
  artifacts: DesktopReleaseArtifact[];
}
const digest = /^[a-f0-9]{64}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid desktop metadata object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Desktop metadata has missing or unsupported fields.");
}
function asset(value: Record<string, unknown>, expectedName: string, names: Set<string>): void {
  if (value.name !== expectedName || names.has(expectedName.toLowerCase()))
    throw new Error("Unexpected or duplicate desktop asset filename.");
  names.add(expectedName.toLowerCase());
  if (
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !digest.test(value.sha256)
  )
    throw new Error("Invalid desktop asset size or digest.");
}
/** Call only after both signatures and the hash of the original primary bytes have been verified. */
export function validateDesktopReleaseManifest(
  value: unknown,
  primary: ForkReleaseManifest,
): asserts value is DesktopReleaseManifest {
  validateForkReleaseManifest(primary);
  const manifest = object(value);
  const identity = [
    "keyId",
    "repository",
    "lineage",
    "version",
    "sourceSha",
    "upstreamBase",
    "releaseTag",
  ] as const;
  keys(manifest, ["schemaVersion", ...identity, "primaryManifestSha256", "artifacts"]);
  if (
    manifest.schemaVersion !== 1 ||
    identity.some((key) => manifest[key] !== primary[key]) ||
    typeof manifest.primaryManifestSha256 !== "string" ||
    !digest.test(manifest.primaryManifestSha256)
  )
    throw new Error("Desktop manifest identity differs from the primary release.");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3)
    throw new Error("Desktop inventory requires all three targets.");
  const cells = new Set(["windows/x64/nsis", "linux/x64/nix-desktop", "linux/arm64/nix-desktop"]);
  const names = new Set<string>();
  const base = ["platform", "arch", "kind", "name", "bytes", "sha256"];
  for (const item of manifest.artifacts) {
    const entry = object(item);
    if (!cells.delete(`${entry.platform}/${entry.arch}/${entry.kind}`))
      throw new Error("Unknown or duplicate desktop target.");
    if (entry.platform === "windows") {
      keys(entry, [...base, "sha512"]);
      asset(entry, `paseo-${primary.version}-windows-x64.exe`, names);
      if (typeof entry.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512))
        throw new Error("Invalid installer SHA-512.");
    } else {
      keys(entry, [...base, "system", "outputPath", "outputPaths", "closureManifest"]);
      const prefix = `paseo-${primary.version}-linux-${entry.arch}-nix`;
      asset(entry, `${prefix}.tar`, names);
      const closure = object(entry.closureManifest);
      keys(closure, ["name", "bytes", "sha256"]);
      asset(closure, `${prefix}.json`, names);
      const system = entry.arch === "x64" ? "x86_64-linux" : "aarch64-linux";
      const storePath = (product: string) =>
        new RegExp(
          `^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-${product}-${primary.version.replaceAll(".", "\\.")}$`,
        );
      if (
        entry.system !== system ||
        !Array.isArray(entry.outputPaths) ||
        entry.outputPaths.length !== 2 ||
        !storePath("paseo").test(entry.outputPaths[0]) ||
        !storePath("paseo-desktop").test(entry.outputPaths[1]) ||
        entry.outputPath !== entry.outputPaths[1]
      )
        throw new Error("Linux output paths or system do not match the desktop target.");
    }
  }
}
