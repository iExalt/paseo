import { forkAndroidVersionCode } from "@getpaseo/protocol/fork-version";
import {
  FORK_ANDROID_CERTIFICATE_SHA256,
  FORK_ANDROID_PACKAGE_ID,
  FORK_RELEASE_LINEAGE,
  FORK_RELEASE_REPOSITORY,
  type ForkReleaseArtifact,
  type ForkReleaseManifest,
} from "@getpaseo/protocol/release-manifest-v2";
import { PASEO_RELEASE_MANIFEST_KEY_ID } from "@getpaseo/protocol/release-manifest";

export function forkReleaseManifestFixture(version = "0.1.0"): ForkReleaseManifest {
  const artifacts: ForkReleaseArtifact[] = [];
  const asset = (name: string) => ({ name, bytes: 123, sha256: "a".repeat(64) });
  for (const arch of ["arm64", "x64"] as const) {
    for (const kind of ["nix-daemon", "nix-desktop"] as const) {
      for (const platform of arch === "arm64" && kind === "nix-desktop"
        ? (["linux", "macos"] as const)
        : (["linux"] as const)) {
        const name = `${platform}-${arch}-${kind}`;
        const linuxSystem = arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
        artifacts.push({
          ...asset(`${name}.tar.zst`),
          platform,
          arch,
          kind,
          system: platform === "macos" ? "aarch64-darwin" : linuxSystem,
          outputPath: `/nix/store/${"a".repeat(32)}-${kind === "nix-desktop" ? "paseo-desktop" : "paseo"}-${version}`,
          closureManifest: asset(`${name}.json`),
        });
      }
    }
    for (const kind of ["deb", "rpm", "appimage", "nsis"] as const) {
      artifacts.push({
        ...asset(`${arch}.${kind}`),
        platform: kind === "nsis" ? "windows" : "linux",
        arch,
        kind,
      });
    }
  }
  artifacts.push({
    ...asset("paseo.apk"),
    platform: "android",
    arch: "arm64",
    kind: "apk",
    abi: "arm64-v8a",
    packageId: FORK_ANDROID_PACKAGE_ID,
    versionCode: forkAndroidVersionCode(version),
    signingCertificateSha256: FORK_ANDROID_CERTIFICATE_SHA256,
  });
  return {
    schemaVersion: 2,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    repository: FORK_RELEASE_REPOSITORY,
    lineage: FORK_RELEASE_LINEAGE,
    version,
    sourceSha: "b".repeat(40),
    upstreamBase: "c".repeat(40),
    releaseTag: `v${version}`,
    artifacts,
  };
}
