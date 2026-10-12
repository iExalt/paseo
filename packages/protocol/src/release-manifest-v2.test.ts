import { describe, expect, it } from "vitest";
import {
  FORK_ANDROID_CERTIFICATE_SHA256,
  FORK_ANDROID_PACKAGE_ID,
  FORK_RELEASE_LINEAGE,
  FORK_RELEASE_REPOSITORY,
  serializeForkReleaseManifest,
  validateForkReleaseManifest,
  type ForkReleaseArtifact,
  type ForkReleaseManifest,
} from "./release-manifest-v2.js";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  validateLegacyPaseoReleaseManifest,
} from "./release-manifest.js";

function manifest(): ForkReleaseManifest {
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
          outputPath: `/nix/store/${"a".repeat(32)}-${kind === "nix-desktop" ? "paseo-desktop" : "paseo"}-0.1.0`,
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
    versionCode: 201000,
    signingCertificateSha256: FORK_ANDROID_CERTIFICATE_SHA256,
  });
  return {
    schemaVersion: 2,
    keyId: PASEO_RELEASE_MANIFEST_KEY_ID,
    repository: FORK_RELEASE_REPOSITORY,
    lineage: FORK_RELEASE_LINEAGE,
    version: "0.1.0",
    sourceSha: "b".repeat(40),
    upstreamBase: "c".repeat(40),
    releaseTag: "v0.1.0",
    artifacts,
  };
}

describe("fork semver release inventory", () => {
  it("serializes the complete matrix without depending on object key insertion order", () => {
    const value = manifest();
    expect(value.artifacts).toHaveLength(14);
    const serialized = serializeForkReleaseManifest(value);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(
      serializeForkReleaseManifest(
        Object.fromEntries(Object.entries(value).toReversed()) as ForkReleaseManifest,
      ),
    ).toBe(serialized);
    expect(() => validateForkReleaseManifest(JSON.parse(serialized))).not.toThrow();
    expect(() => validateLegacyPaseoReleaseManifest(value)).toThrow();
  });

  it("rejects foreign lineage, noncanonical versions, legacy ordering and unbound identities", () => {
    for (const override of [
      { schemaVersion: 1 },
      { repository: "getpaseo/paseo" },
      { lineage: "upstream" },
      { keyId: "untrusted" },
      { version: "0.1.0-beta.1" },
      { version: "00.1.0" },
      { releaseTag: "v0.1.1" },
      { sourceSha: "b".repeat(39) },
      { upstreamBase: "dev" },
      { releaseSequence: 201000 },
      { runAttempt: 1 },
      { artifacts: undefined },
    ])
      expect(() => validateForkReleaseManifest({ ...manifest(), ...override })).toThrow();
  });

  it("requires every exact cell and kind-specific metadata, with no extra fields", () => {
    const mutations: ((value: ForkReleaseManifest) => void)[] = [
      (m) => {
        m.artifacts.pop();
      },
      (m) => {
        m.artifacts[1] = m.artifacts[0];
      },
      (m) => {
        m.artifacts[0].platform = "windows";
      },
      (m) => {
        Object.assign(m.artifacts[0], { system: "aarch64-darwin" });
      },
      (m) => {
        Object.assign(m.artifacts[0], {
          outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-0.1.0`,
        });
      },
      (m) => {
        Object.assign(m.artifacts[0], { outputPath: `/nix/store/${"a".repeat(32)}-paseo-0.2.0` });
      },
      (m) => {
        Object.assign(m.artifacts[0], { releaseSequence: 1 });
      },
      (m) => {
        Object.assign(m.artifacts.at(-1)!, { versionCode: 1000 });
      },
      (m) => {
        Object.assign(m.artifacts.at(-1)!, { signingCertificateSha256: "f".repeat(64) });
      },
      (m) => {
        Object.assign(m.artifacts.at(-1)!, { packageId: "sh.paseo" });
      },
      (m) => {
        Object.assign(m.artifacts.at(-1)!, { abi: "x86_64" });
      },
    ];
    for (const mutate of mutations) {
      const value = manifest();
      mutate(value);
      expect(() => validateForkReleaseManifest(value)).toThrow();
    }
  });

  it("authenticates each portable asset reference and rejects collisions including closure manifests", () => {
    for (const override of [
      { name: "../escape" },
      { name: "a\\b" },
      { name: "a#fragment" },
      { name: "a%2fb" },
      { name: "NUL.json" },
      { name: "trailing." },
      { bytes: 0 },
      { bytes: 1.5 },
      { bytes: Number.MAX_SAFE_INTEGER + 1 },
      { sha256: "bad" },
    ]) {
      const value = manifest();
      Object.assign(value.artifacts[0], override);
      expect(() => validateForkReleaseManifest(value)).toThrow();
    }
    for (const nested of [false, true]) {
      const value = manifest();
      const first = value.artifacts[0];
      if (!("closureManifest" in first)) throw new Error("fixture must start with Nix");
      value.artifacts[1].name = (nested ? first.closureManifest.name : first.name).toUpperCase();
      expect(() => validateForkReleaseManifest(value)).toThrow(/Duplicate/);
    }
  });
});
