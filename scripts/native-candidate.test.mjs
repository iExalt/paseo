import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { validateCandidateClosure } from "../.github/scripts/macos-candidate-runtime.mjs";
import terminalProof from "../packages/desktop/e2e/terminal-proof.cjs";
import nixProfile from "../packages/desktop/e2e/nix-profile.cjs";
import { closeNormally } from "../packages/desktop/e2e/normal-close.cjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import {
  stageTemporaryDirectory,
  validateTemporaryRoot,
} from "../.github/scripts/linux-product-temp.mjs";
import { tmpdir } from "node:os";
import {
  ownedProcesses,
  unreadableUnknowns,
  verifyCompleteMonitor,
  reconcilePrivilegedScan,
} from "../.github/scripts/linux-format-processes.mjs";
import { join } from "node:path";
import { verifyNamespacePid } from "../.github/scripts/linux-format-fixture/process-identity.cjs";
import { createPackage } from "@electron/asar";
import {
  payloadFiles,
  digest,
  validateManifest,
  verifyPayload,
} from "../packages/desktop/e2e/linux-installed-layout.cjs";

test(
  "owned product temporary paths support real singleton sockets and reject substituted roots",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync("/tmp/paseo-");
    const stat = lstatSync(directory);
    const record = { path: directory, uid: stat.uid, dev: stat.dev, ino: stat.ino };
    const server = createServer();
    try {
      if (process.platform === "linux") {
        validateTemporaryRoot(record);
        assert.throws(() => validateTemporaryRoot({ ...record, ino: record.ino + 1 }));
      }
      assert.throws(() => stageTemporaryDirectory(record, "../unowned"));
      const socketDirectory = join(
        stageTemporaryDirectory(record, "appimage-previous"),
        "scoped_dir123456",
      );
      mkdirSync(socketDirectory, { recursive: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(socketDirectory, "SingletonSocket"), resolve);
      });
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true });
      symlinkSync(tmpdir(), directory);
      if (process.platform === "linux") assert.throws(() => validateTemporaryRoot(record));
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("installed package identity binds source, archive paths, metadata and native payload bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-installed-identity-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    mkdirSync(join(root, "resources/bin"), { recursive: true });
    const metadata = { name: "@getpaseo/desktop", version: "0.11.2", desktopName: "Paseo.desktop" };
    writeFileSync(join(source, "package.json"), JSON.stringify(metadata));
    await createPackage(source, join(root, "resources/app.asar"));
    for (const filename of payloadFiles.filter((name) => name !== "resources/app.asar"))
      writeFileSync(join(root, filename), "fixture");
    const elf = Buffer.alloc(20);
    elf.write("\x7fELF");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(62, 18);
    writeFileSync(join(root, "Paseo.bin"), elf);
    const item = {
      ...metadata,
      sourceSha: "a".repeat(40),
      lockHash: "b".repeat(64),
      payload: Object.fromEntries(payloadFiles.map((file) => [file, digest(join(root, file))])),
      artifacts: {
        deb: { file: "candidate.deb", sha256: "c".repeat(64), packageName: "paseo" },
        rpm: { file: "candidate.rpm", sha256: "d".repeat(64), packageName: "Paseo" },
        appimage: {
          file: "candidate.AppImage",
          sha256: "e".repeat(64),
          appRunSha256: "f".repeat(64),
        },
      },
    };
    const manifest = {
      schema: 1,
      architecture: "x64",
      candidate: item,
      previous: {
        ...item,
        payload: { ...item.payload },
        version: "0.11.0",
        sourceSha: "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a",
      },
    };
    const hook = join(root, "resources/linux-after-install.sh");
    writeFileSync(hook, "fixture");
    item.payload["resources/linux-after-install.sh"] = digest(hook);
    validateManifest(manifest, item.sourceSha, "x64");
    assert.throws(() => validateManifest(manifest, "0".repeat(40), "x64"));
    assert.throws(() => validateManifest(manifest, item.sourceSha, "arm64"));
    const badPath = structuredClone(manifest);
    badPath.candidate.artifacts.deb.file = "../candidate.deb";
    assert.throws(() => validateManifest(badPath, item.sourceSha, "x64"));
    verifyPayload(root, item, "x64");
    assert.throws(() => verifyPayload(root, { ...item, version: "0.11.0" }, "x64"));
    assert.throws(() => verifyPayload(root, item, "arm64"));
    writeFileSync(hook, "changed package hook");
    assert.throws(() => verifyPayload(root, item, "x64"));
    writeFileSync(hook, "fixture");
    writeFileSync(join(root, "Paseo"), "changed runtime launcher");
    assert.throws(() => verifyPayload(root, item, "x64"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderer identity maps observer and nested namespace PIDs without trusting missing mappings", () => {
  assert.deepEqual(verifyNamespacePid("NSpid:\t3745\n", 3745, 3745), [3745]);
  assert.deepEqual(verifyNamespacePid("NSpid:\t3745\t8\t1\n", 3745, 1), [3745, 8, 1]);
  for (const [status, observer, renderer] of [
    ["Pid:\t3745\n", 3745, 1],
    ["NSpid:\t3745 nope\n", 3745, 1],
    ["NSpid:\t3745 0\n", 3745, 0],
    ["NSpid:\t3745 1\n", 9, 1],
    ["NSpid:\t3745 1\n", 3745, 9],
  ])
    assert.throws(() => verifyNamespacePid(status, observer, renderer));
});

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
  const detached = [
    { pid: 20, parent: 1, session: 20, start: "110", owner: "token" },
    { pid: 21, parent: 20, session: 20, start: "111", unreadable: true },
    { pid: 22, parent: 1, session: 22, start: "112", unreadable: true },
  ];
  const members = ownedProcesses(detached, 10, retained, "token");
  assert.deepEqual(members, detached.slice(0, 2));
  assert.deepEqual(unreadableUnknowns(detached, members), [detached[2]]);
  assert.deepEqual(unreadableUnknowns(detached, [...members, detached[2]]), []);
  const before = [
    { pid: 30, start: "120", unreadable: true },
    { pid: 31, start: "121", unreadable: true },
  ];
  const after = [
    { pid: 31, start: "999" },
    { pid: 32, start: "122" },
  ];
  const scan = reconcilePrivilegedScan(before, after, [31, 32], "token");
  assert.deepEqual(scan.rows, []);
  assert.equal(scan.pending, true);
  assert.deepEqual(reconcilePrivilegedScan(before, [], [], "token"), { rows: [], pending: false });
  const live = reconcilePrivilegedScan(before, before, [30], "token");
  assert.deepEqual(ownedProcesses(live.rows, 0, [], "token"), [live.rows[0]]);
  assert.equal(live.pending, false);
  const started = { owner: "token" };
  const complete = { owner: "token", complete: true, remaining: [], mounts: [] };
  verifyCompleteMonitor(started, complete);
  for (const invalid of [
    undefined,
    { ...complete, complete: false },
    { ...complete, owner: "other" },
    { ...complete, remaining: [detached[0]] },
    { ...complete, mounts: ["live"] },
  ])
    assert.throws(() => verifyCompleteMonitor(started, invalid));
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
