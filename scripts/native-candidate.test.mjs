import assert from "node:assert/strict";
import test from "node:test";
import { validateCandidateClosure } from "../.github/scripts/macos-candidate-runtime.mjs";

test("native candidate reader rejects legacy or mismatched closure identities", () => {
  const candidate = {
    sourceSha: "a".repeat(40),
    forkVersion: "0.11.2",
    macOS: {
      lockHash: "b".repeat(64),
      outputPath: `/nix/store/${"c".repeat(32)}-desktop`,
    },
  };
  const manifest = {
    kind: "paseo-verification-candidate",
    schemaVersion: 2,
    platform: "macos-arm64",
    sourceSha: candidate.sourceSha,
    forkVersion: candidate.forkVersion,
    packageVersion: candidate.forkVersion,
    system: "aarch64-darwin",
    ...candidate.macOS,
    provenance: "local-ci-build",
    closure: [{ path: candidate.macOS.outputPath }],
  };
  validateCandidateClosure(manifest, candidate);
  for (const delta of [
    { schemaVersion: 1 },
    { releaseSequence: 200008 },
    { kind: "published" },
    { sourceSha: "d".repeat(40) },
    { forkVersion: "0.11.0" },
    { packageVersion: "0.11.0" },
    { lockHash: "e".repeat(64) },
    { outputPath: "/nix/store/other" },
    { closure: [] },
  ]) {
    assert.throws(() => validateCandidateClosure({ ...manifest, ...delta }, candidate));
  }
});
