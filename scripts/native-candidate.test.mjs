import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { validateCandidateClosure } from "../.github/scripts/macos-candidate-runtime.mjs";
import terminalProof from "../packages/desktop/e2e/terminal-proof.cjs";

test("terminal execution proof cannot accept echoed commands", () => {
  const marker = "paseo-packaged-terminal-smoke-123";
  for (const platform of ["linux", "win32"]) {
    const command = terminalProof.terminalHookCommand(marker, platform);
    assert.ok(!command.includes(marker));
    assert.equal(terminalProof.hasTerminalOutput([command], marker), false);
    assert.equal(terminalProof.hasTerminalOutput([`prompt ${marker}`], marker), false);
    assert.equal(terminalProof.hasTerminalOutput([command, `  ${marker}  `], marker), true);
    const script =
      platform === "win32"
        ? Buffer.from(command.split(" ").at(-1), "base64").toString("utf16le")
        : command;
    assert.ok(!script.includes(marker));
    assert.ok(script.includes(platform === "win32" ? "$LASTEXITCODE -ne 0" : "&& printf"));
  }
  if (process.platform !== "win32") {
    const command = terminalProof.terminalHookCommand(marker, "linux");
    assert.equal(
      execFileSync("/bin/sh", ["-c", command], {
        env: { ...process.env, PASEO_HOOK_CLI: "/usr/bin/true" },
        encoding: "utf8",
      }).trim(),
      marker,
    );
    assert.throws(() =>
      execFileSync("/bin/sh", ["-c", command], {
        env: { ...process.env, PASEO_HOOK_CLI: "/usr/bin/false" },
      }),
    );
  }
});

test("Android first-use controls distinguish the keyboard prompt and focused input", () => {
  execFileSync("python3", ["-B", ".github/scripts/android_candidate_controls_test.py"], {
    timeout: 5000,
  });
});

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
