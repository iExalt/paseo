import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "win32");
assert.equal(process.arch, "arm64");
assert.equal(process.version, "v26.11.0");
const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "../..");
const commit = "11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf";
const sourceRoot = `sherpa-onnx-${commit}`;
const coreRoot = "sherpa-onnx-v1.13.8-win-arm64-shared-MD-Release";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", timeout: 300_000, ...options });

function assertArm64PE(filename) {
  const bytes = readFileSync(filename);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ", filename);
  const header = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", header, header + 4), "PE\0\0", filename);
  assert.equal(bytes.readUInt16LE(header + 4), 0xaa64, filename);
}

async function exercise(directory) {
  const require = createRequire(join(directory, "package.json"));
  const sherpa = require("./runtime/sherpa-onnx.js");
  const nativeModules = process.report
    .getReport()
    .sharedObjects.filter((name) => /onnxruntime|sherpa/i.test(name));
  console.log("Loaded native modules:", nativeModules);
  const loadedAddons = Object.keys(require.cache).filter((name) =>
    /sherpa-onnx\.node$/i.test(name),
  );
  console.log("Loaded binding:", loadedAddons);
  assert.deepEqual(
    loadedAddons.map((name) => name.toLowerCase()),
    [join(directory, "runtime/sherpa-onnx.node").toLowerCase()],
  );
  assert.equal(sherpa.onnxruntimeVersion, "1.28.2");
  for (const filename of nativeModules.filter((name) => /onnxruntime\.dll$/i.test(name))) {
    assert.equal(
      win32.toNamespacedPath(filename).toLowerCase(),
      win32.toNamespacedPath(join(directory, "runtime/onnxruntime.dll")).toLowerCase(),
    );
  }
  const buffer = new sherpa.CircularBuffer(8);
  buffer.push(new Float32Array([1, 2]));
  assert.deepEqual([...buffer.get(0, 2)], [1, 2]);
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: join(
          repository,
          "packages/server/src/server/speech/providers/local/sherpa/assets/silero_vad.onnx",
        ),
        threshold: 0.5,
        minSilenceDuration: 0.2,
        minSpeechDuration: 0.1,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
    2,
  );
  for (let frame = 0; frame < 32; frame++) vad.acceptWaveform(new Float32Array(512));
  assert.equal(vad.isDetected(), false);
  assert.equal(vad.isEmpty(), true);
  console.log("PASS: ARM64 custom binding, buffer and real Silero VAD inference on silence");

  const pty = require("./pty/package");
  let terminal;
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY output timed out")), 10_000);
      let output = "";
      terminal = pty.spawn("cmd.exe", ["/d", "/c", "echo paseo-arm64-pty"], {
        cwd: directory,
        env: process.env,
      });
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0 && output.includes("paseo-arm64-pty")) resolvePromise();
        else reject(new Error(`PTY failed (${exitCode}): ${output}`));
      });
    });
  } finally {
    terminal?.kill();
  }
  console.log("PASS: native Windows ARM64 PTY output");
  const fixture = join(directory, "watch");
  mkdirSync(fixture);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("Watcher timed out"));
    }, 10_000);
    const watcher = watch(fixture, { recursive: true }, (_event, name) => {
      if (String(name).includes("sentinel")) {
        clearTimeout(timer);
        watcher.close();
        resolvePromise();
      }
    });
    writeFileSync(join(fixture, "sentinel"), "probe");
  });
  console.log("PASS: native Windows ARM64 recursive watcher event");
}

if (process.argv[2] === "exercise") {
  await exercise(process.argv[3]);
} else {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP, "paseo-arm64-binding-"));
  async function download(name, url, expected, algorithm = "sha256", encoding = "hex") {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    assert.ok(response.ok, `${response.status} ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash(algorithm).update(bytes).digest(encoding), expected, name);
    const filename = join(directory, name);
    writeFileSync(filename, bytes);
    console.log(`Verified ${name}: ${bytes.length} bytes`);
    return filename;
  }
  try {
    const source = await download(
      "source.tar.gz",
      `https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/${commit}`,
      "0a8db6c55dd318f4a688faba85f7760b99a6c92e8ef8864479d418531bee1ac2",
    );
    const core = await download(
      "core.tar.bz2",
      `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${coreRoot}.tar.bz2`,
      "40fd749779c41e357c4a1382b071970999d4828ceb50b133b1643878ca08ead8",
    );
    const headers = await download(
      "headers.tar.gz",
      "https://nodejs.org/dist/v26.11.0/node-v26.11.0-headers.tar.gz",
      "b99396d1721ae64db1b615da88bd758947e12f4cd101a5ce0222a3b4b7e25409",
    );
    const nodeLib = await download(
      "node.lib",
      "https://nodejs.org/dist/v26.11.0/win-arm64/node.lib",
      "45084cbfc0170d7a30b29ab1eeeb2b0d770995ade0a13a4cc82cf31189f95c9f",
    );
    const addon = await download(
      "addon.tgz",
      "https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.3.1.tgz",
      "lytcDEdxKjGJPTLEfW4mYMigRezMlyJY8W4wxJK8zE533Jlb8L8dRuObJFWg2P+AuOIxoCgKF+2Oq4d4Zd0OUA==",
      "sha512",
      "base64",
    );
    const pty = await download(
      "pty.tgz",
      "https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz",
      "20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==",
      "sha512",
      "base64",
    );
    const cpp = `${sourceRoot}/harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp`;
    // Node binding sources are symlinks to these regular files; avoid Windows symlink privileges.
    run("tar", [
      "-xf",
      source,
      "-C",
      directory,
      "--include",
      `${sourceRoot}/scripts/node-addon-api/lib/*`,
      "--include",
      `${cpp}/*.cc`,
      "--include",
      `${cpp}/*.h`,
    ]);
    for (const archive of [core, headers]) run("tar", ["-xf", archive, "-C", directory]);
    for (const [name, archive] of [
      ["addon", addon],
      ["pty", pty],
    ]) {
      mkdirSync(join(directory, name));
      run("tar", ["-xf", archive, "-C", join(directory, name)]);
    }
    const coreDirectory = join(directory, coreRoot);
    const build = join(directory, "build");
    const cmakePath = (value) => value.replaceAll("\\", "/");
    run("cmake", ["--version"]);
    run("cmake", [
      "-S",
      join(dirname(script), "windows-arm64-binding"),
      "-B",
      build,
      "-G",
      "Visual Studio 18 2026",
      "-A",
      "ARM64",
      `-DBINDING_SOURCE=${cmakePath(join(directory, cpp))}`,
      `-DSHERPA_CORE=${cmakePath(coreDirectory)}`,
      `-DNODE_HEADERS=${cmakePath(join(directory, "node-v26.11.0"))}`,
      `-DNODE_IMPORT_LIB=${cmakePath(nodeLib)}`,
      `-DADDON_API=${cmakePath(join(directory, "addon/package"))}`,
    ]);
    run("cmake", ["--build", build, "--config", "Release", "--parallel", "2"], {
      timeout: 600_000,
    });
    const runtime = join(directory, "runtime");
    cpSync(join(directory, sourceRoot, "scripts/node-addon-api/lib"), runtime, { recursive: true });
    cpSync(join(build, "Release/sherpa-onnx.node"), join(runtime, "sherpa-onnx.node"));
    for (const filename of readdirSync(join(coreDirectory, "lib")).filter((name) =>
      name.endsWith(".dll"),
    )) {
      assertArm64PE(join(coreDirectory, "lib", filename));
      cpSync(join(coreDirectory, "lib", filename), join(runtime, filename));
    }
    assertArm64PE(join(runtime, "sherpa-onnx.node"));
    // The upstream wrapper prefers ../build/Release over its local addon.
    // Exercise only the assembled runtime, not the DLL-less compiler output.
    rmSync(build, { recursive: true });
    for (const filename of readdirSync(join(directory, "pty/package/prebuilds/win32-arm64")).filter(
      (name) => name.endsWith(".node"),
    ))
      assertArm64PE(join(directory, "pty/package/prebuilds/win32-arm64", filename));
    run(process.execPath, [join(directory, "pty/package/scripts/prebuild.js")], {
      cwd: join(directory, "pty/package"),
    });
    run(process.execPath, [join(directory, "pty/package/scripts/post-install.js")], {
      cwd: join(directory, "pty/package"),
    });
    // Application-directory DLL lookup precedes system directories and PATH.
    // Keep the trusted Node copy beside the pinned DLLs; never modify system DLLs.
    const runtimeNode = join(runtime, "node.exe");
    cpSync(process.execPath, runtimeNode);
    assertArm64PE(runtimeNode);
    run(runtimeNode, [script, "exercise", directory], {
      timeout: 60_000,
      env: { ...process.env, PATH: `${runtime};${process.env.PATH}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
