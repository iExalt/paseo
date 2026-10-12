import type {
  ForkReleaseArtifact,
  ForkReleaseManifest,
} from "@getpaseo/protocol/release-manifest-v2";

export function forkReleaseManifestFixture(version = "0.1.0"): ForkReleaseManifest {
  const [major, minor, patch] = version.split(".").map(Number);
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
    packageId: "sh.paseo.iexalt",
    versionCode: 200000 + major * 1000000 + minor * 1000 + patch,
    signingCertificateSha256: "943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459",
  });
  return {
    schemaVersion: 2,
    keyId: "paseo-release-manifest-1",
    repository: "iExalt/paseo",
    lineage: "iExalt/paseo:semver-v1",
    version,
    sourceSha: "b".repeat(40),
    upstreamBase: "c".repeat(40),
    releaseTag: `paseo-v${version}`,
    artifacts,
  };
}
