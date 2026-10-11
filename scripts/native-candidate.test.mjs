import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { validateCandidateClosure } from "../.github/scripts/macos-candidate-runtime.mjs";
import terminalProof from "../packages/desktop/e2e/terminal-proof.cjs";
import nixProfile from "../packages/desktop/e2e/nix-profile.cjs";
import { closeNormally } from "../packages/desktop/e2e/normal-close.cjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ownedProcesses } from "../.github/scripts/linux-format-processes.mjs";
import { join } from "node:path";

test("fixture cleanup retains observed children across session changes without claiming reused PIDs", () => {
  const retained = [
    { pid: 10, session: 10, start: "100" },
    { pid: 11, session: 10, start: "101" },
  ];
  const rows = [
    { pid: 11, session: 11, start: "101" },
    { pid: 10, session: 90, start: "999" },
    { pid: 12, session: 10, start: "102" },
    { pid: 90, session: 90, start: "50" },
  ];
  assert.deepEqual(ownedProcesses(rows, 10, retained), [rows[0], rows[2]]);
  assert.deepEqual(ownedProcesses([], 10, retained), []);
});

test("normal replacement shutdown requires close acknowledgement and bounded exit", async () => {
  const events = [];
  await closeNormally({
    child: { exitCode: 0, signalCode: null },
    requestClose: async () => events.push("close"),
    waitForExit: async (timeout) => {
      events.push(timeout);
      return true;
    },
  });
  assert.deepEqual(events, ["close", 10000]);
  for (const child of [
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" },
  ]) {
    await assert.rejects(
      closeNormally({
        child,
        requestClose: async () => {},
        waitForExit: async () => true,
      }),
      /Normal close/,
    );
  }
  await assert.rejects(
    closeNormally({ requestClose: async () => {}, waitForExit: async () => false }),
    /must exit/,
  );
  await assert.rejects(
    closeNormally({
      requestClose: async () => {
        throw new Error("IPC failure");
      },
      waitForExit: async () => {
        assert.fail("Must not hide an IPC failure");
      },
    }),
    /IPC failure/,
  );
});

test("Nix profile verification rejects stale packages and wrong binary targets", () => {
  const manifest = { version: 3, elements: { daemon: { active: true, storePaths: ["old"] } } };
  nixProfile.assertProfilePackages(manifest, ["old"]);
  assert.throws(() => nixProfile.assertProfilePackages(manifest, ["new"]));
  assert.throws(() => nixProfile.assertProfilePackages(manifest, []));
  nixProfile.assertProfilePackages({ version: 3, elements: {} }, []);
  const root = mkdtempSync(join(tmpdir(), "nix-profile-links-"));
  try {
    const profile = join(root, "profile");
    mkdirSync(join(profile, "bin"), { recursive: true });
    const canonical = { executablePath: join(root, "desktop"), cliPath: join(root, "cli") };
    for (const file of Object.values(canonical)) writeFileSync(file, "fixture");
    symlinkSync(canonical.executablePath, join(profile, "bin/paseo-desktop"));
    symlinkSync(canonical.cliPath, join(profile, "bin/paseo"));
    assert.deepEqual(nixProfile.profileExecutables(profile, canonical), {
      executablePath: join(profile, "bin/paseo-desktop"),
      cliPath: join(profile, "bin/paseo"),
    });
    assert.throws(() =>
      nixProfile.profileExecutables(profile, {
        ...canonical,
        cliPath: canonical.executablePath,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Nix environment diagnostics validate the v4 envelope", () => {
  const valid = {
    version: 4,
    derivations: {
      "fixture.drv": { version: 4, env: { NIX_BUILD_CORES: "2", unrelated: "value" } },
    },
  };
  const filter = (input) =>
    execFileSync("jq", ["-e", "-f", ".github/scripts/nix-build-environment.jq"], {
      input: JSON.stringify(input),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1000,
    });
  assert.deepEqual(JSON.parse(filter(valid)), { "fixture.drv": { NIX_BUILD_CORES: "2" } });
  for (const input of [
    {},
    { ...valid, version: 3 },
    { version: 4, derivations: [] },
    { version: 4, derivations: { "fixture.drv": { version: 4, env: null } } },
  ]) {
    assert.throws(() => filter(input));
  }
});

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
