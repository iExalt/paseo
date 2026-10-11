import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPackageWithOptions } from "@electron/asar";
import { assertElectronArmBinding, inspectPe } from "../.github/scripts/windows-pe.mjs";
import { verifyWindowsJob } from "../.github/scripts/windows-job-identity.mjs";
import {
  assertWrapperTarget,
  bindingProvenance,
  digest,
  verifyStagedBinding,
  verifyPackagedArmBinding,
} from "../.github/scripts/windows-speech-binding.mjs";

function pe({ machine = 0xaa64, delayed = true, normalNode = false } = {}) {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(16, 196);
  bytes.writeUInt32LE(4096, 340);
  bytes.writeUInt32LE(512, 344);
  bytes.writeUInt32LE(512, 348);
  if (normalNode) {
    bytes.writeUInt32LE(4096, 208);
    bytes.writeUInt32LE(40, 212);
    bytes.writeUInt32LE(4096 + 200, 512 + 12);
  }
  if (delayed) {
    bytes.writeUInt32LE(4096 + 64, 304);
    bytes.writeUInt32LE(64, 308);
    bytes.writeUInt32LE(1, 576);
    bytes.writeUInt32LE(4096 + 200, 580);
  }
  bytes.write("node.exe\0", 712);
  return bytes;
}

test("ARM Electron binding requires delayed executable imports and file-backed PE data", () => {
  assert.deepEqual(assertElectronArmBinding(pe()), {
    machine: 0xaa64,
    imports: [],
    delayedImports: ["node.exe"],
  });
  assert.throws(() => assertElectronArmBinding(pe({ machine: 0x8664 })), /ARM64/);
  assert.throws(() => assertElectronArmBinding(pe({ delayed: false })), /delay-load/);
  assert.throws(() => assertElectronArmBinding(pe({ normalNode: true })), /normal import/);
  assert.throws(() => inspectPe(pe().subarray(0, 600)), /Truncated/);
});

test("staged binding inventory rejects changed binaries and unlisted content", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-binding-"));
  try {
    const files = ["sherpa-onnx.node", "sherpa-onnx-c-api.dll", "onnxruntime.dll"].map((name) => {
      const bytes = pe({ delayed: name.endsWith(".node") });
      writeFileSync(join(root, name), bytes);
      return { name, bytes: bytes.length, sha256: digest(bytes) };
    });
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        schema: 1,
        architecture: "arm64",
        electron: "44.6.0",
        sherpa: "1.13.8",
        onnxruntime: "1.28.2",
        sourceCommit: "11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf",
        provenance: bindingProvenance(),
        files,
      }),
    );
    assert.equal(verifyStagedBinding(root).files.length, 3);
    const manifestFile = join(root, "manifest.json");
    const original = readFileSync(manifestFile);
    const manifest = JSON.parse(original);
    delete manifest.provenance;
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyStagedBinding(root), /Pinned assembly provenance/);
    manifest.provenance = bindingProvenance();
    manifest.provenance.delayHookSha256 = "0".repeat(64);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyStagedBinding(root), /Pinned assembly provenance/);
    writeFileSync(manifestFile, original);
    writeFileSync(join(root, "unexpected.dll"), "extra");
    assert.throws(() => verifyStagedBinding(root));
    rmSync(join(root, "unexpected.dll"));
    const bytes = readFileSync(join(root, "onnxruntime.dll"));
    bytes[bytes.length - 1] = 1;
    writeFileSync(join(root, "onnxruntime.dll"), bytes);
    assert.throws(() => verifyStagedBinding(root), /onnxruntime.dll/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("local addon preparation preserves pinned wrapper and rejects shadowing", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-wrapper-"));
  const wrapper = join(root, "sherpa-onnx-node");
  try {
    mkdirSync(wrapper);
    for (const name of ["package.json", "addon.js", "addon-static-import.js"])
      cpSync(
        new URL(`../node_modules/sherpa-onnx-node/${name}`, import.meta.url),
        join(wrapper, name),
      );
    assertWrapperTarget(wrapper);
    mkdirSync(join(root, "build/Release"), { recursive: true });
    writeFileSync(join(root, "build/Release/sherpa-onnx.node"), "shadow");
    assert.throws(() => assertWrapperTarget(wrapper), /shadowed/);
    rmSync(join(root, "build"), { recursive: true });
    writeFileSync(join(wrapper, "addon-static-import.js"), "changed loader");
    assert.throws(() => assertWrapperTarget(wrapper), /Pinned loader/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("packaged binding requires a physically unpacked addon and executable-directory DLLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-binding-asar-"));
  try {
    const staged = join(root, "staged");
    mkdirSync(staged);
    const files = ["sherpa-onnx.node", "sherpa-onnx-c-api.dll", "onnxruntime.dll"].map((name) => {
      const bytes = pe({ delayed: name.endsWith(".node") });
      writeFileSync(join(staged, name), bytes);
      return { name, bytes: bytes.length, sha256: digest(bytes) };
    });
    writeFileSync(
      join(staged, "manifest.json"),
      JSON.stringify({
        schema: 1,
        architecture: "arm64",
        electron: "44.6.0",
        sherpa: "1.13.8",
        onnxruntime: "1.28.2",
        sourceCommit: "11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf",
        provenance: bindingProvenance(),
        files,
      }),
    );
    const source = join(root, "source");
    const wrapper = join(source, "node_modules/sherpa-onnx-node");
    mkdirSync(wrapper, { recursive: true });
    for (const name of ["addon.js", "addon-static-import.js"])
      cpSync(
        new URL(`../node_modules/sherpa-onnx-node/${name}`, import.meta.url),
        join(wrapper, name),
      );
    cpSync(join(staged, "sherpa-onnx.node"), join(wrapper, "sherpa-onnx.node"));
    for (const unpack of [true, false]) {
      const app = join(root, `app-${unpack}`);
      mkdirSync(join(app, "resources"), { recursive: true });
      writeFileSync(join(app, "Paseo.exe"), pe({ delayed: false }));
      for (const file of files.filter((entry) => entry.name.endsWith(".dll")))
        cpSync(join(staged, file.name), join(app, file.name));
      await createPackageWithOptions(
        source,
        join(app, "resources/app.asar"),
        unpack ? { unpack: "**/*.node" } : {},
      );
      const verify = () =>
        verifyPackagedArmBinding(fileURLToPath(new URL("../", import.meta.url)), app, staged);
      if (unpack) assert.equal(verify().architecture, "arm64");
      else assert.throws(verify, /Physical addon unpack/);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("Windows ownership authorization binds the current primary to the exact stage and source", () => {
  const temporary = mkdtempSync(join(tmpdir(), "paseo-job-identity-"));
  try {
    const root = join(temporary, "paseo-windows-products-123-1");
    mkdirSync(root);
    const start = join(root, "init-start.json");
    const specification = join(root, "init-spec.json");
    const argv = ["fixture.mjs", "init"];
    const specBytes = JSON.stringify({
      startReceipt: start,
      executable: process.execPath,
      arguments: argv,
      directory: root,
    });
    writeFileSync(specification, specBytes);
    const env = {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "a".repeat(40),
      RUNNER_TEMP: temporary,
      GITHUB_WORKSPACE: root,
      PASEO_WINDOWS_JOB_START: start,
    };
    writeFileSync(
      start,
      JSON.stringify({
        primaryPid: 4242,
        monitorPid: 5000,
        killOnClose: true,
        breakaway: false,
        identity: {
          specification,
          specificationSha256: digest(specBytes),
          sourceSha: env.GITHUB_SHA,
          runId: "123",
          attempt: "1",
        },
      }),
    );
    const facts = { platform: "win32", pid: 4242, executable: process.execPath, argv, env };
    assert.equal(verifyWindowsJob(facts).stage, "init");
    assert.throws(
      () => verifyWindowsJob({ ...facts, env: { ...env, PASEO_WINDOWS_JOB_START: undefined } }),
      /Outer Windows Job/,
    );
    assert.throws(() => verifyWindowsJob({ ...facts, pid: 4243 }), /this primary/);
    assert.throws(() =>
      verifyWindowsJob({ ...facts, env: { ...env, GITHUB_SHA: "b".repeat(40) } }),
    );
    writeFileSync(specification, `${specBytes}\n`);
    assert.throws(() => verifyWindowsJob(facts));
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
