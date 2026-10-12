import { forkReleaseManifestFixture as manifest } from "../../../scripts/test-fixtures/fork-release-manifest";
import { describe, expect, it } from "vitest";
import {
  serializeForkReleaseManifest,
  validateForkReleaseManifest,
  type ForkReleaseManifest,
} from "./release-manifest-v2.js";
import { validateLegacyPaseoReleaseManifest } from "./release-manifest.js";

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
