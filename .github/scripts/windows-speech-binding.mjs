import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertElectronArmBinding, inspectPe } from "./windows-pe.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceCommit = "11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf";
const sourceRoot = `sherpa-onnx-${sourceCommit}`;
const coreRoot = "sherpa-onnx-v1.13.8-win-arm64-shared-MD-Release";
const wrapperHashes = {
  "addon.js": "ccdfdd81775611bb1b4de2f30fc22a987f9d6936b280c91b6a0c597e02f3c839",
  "addon-static-import.js": "4e1cdabab1dc22ecff6882ea642aba56c6e03c543dd366e684ae5b853dd5f1b6",
};
const delayHookHash = "ec2357ffdf512151c21a52326ad3396aaa650b83e5c4a31153d216a155f68ecc";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pinnedInputs = [
  {
    name: "source.tar.gz",
    url: `https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/${sourceCommit}`,
    sha256: "0a8db6c55dd318f4a688faba85f7760b99a6c92e8ef8864479d418531bee1ac2",
  },
  {
    name: "core.tar.bz2",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${coreRoot}.tar.bz2`,
    sha256: "40fd749779c41e357c4a1382b071970999d4828ceb50b133b1643878ca08ead8",
  },
  {
    name: "headers.tar.gz",
    url: "https://artifacts.electronjs.org/headers/dist/v44.6.0/node-v44.6.0-headers.tar.gz",
    sha256: "8c559da0c922a68d9e41c5a8f8abef332c5d4814e7b55dd28e3d2245d751fd19",
  },
  {
    name: "node.lib",
    url: "https://artifacts.electronjs.org/headers/dist/v44.6.0/win-arm64/node.lib",
    sha256: "bc290c92c6811f13a75cca8e1495f2d14906287b59610c1e63f042c169fbed20",
  },
  {
    name: "addon.tgz",
    url: "https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.3.1.tgz",
    sha256: "7ca0aa7ad8e07f8134d1b0b5d8677cdd5cf2c4ded5c8e035f337b9e8a97bbde6",
  },
];

export function bindingProvenance() {
  return {
    inputs: pinnedInputs,
    delayHookSha256: delayHookHash,
    wrapperHashes,
    recipeHashes: Object.fromEntries(
      [
        "windows-speech-binding.mjs",
        "windows-pe.mjs",
        "windows-electron-binding/CMakeLists.txt",
      ].map((name) => [name, digest(readFileSync(join(scriptDirectory, name)))]),
    ),
  };
}

export function assertWrapperTarget(wrapper) {
  assert.equal(JSON.parse(readFileSync(join(wrapper, "package.json"))).version, "1.13.8");
  for (const [name, expected] of Object.entries(wrapperHashes))
    assert.equal(digest(readFileSync(join(wrapper, name))), expected, `Pinned loader ${name}`);
  // These are every earlier dynamic candidate for win-arm64. The pinned static
  // loader has no Windows ARM64 branch; never patch or replace its bytes.
  for (const name of [
    "../build/Release/sherpa-onnx.node",
    "../build/Debug/sherpa-onnx.node",
    "node_modules/sherpa-onnx-win-arm64/sherpa-onnx.node",
    "../sherpa-onnx-win-arm64/sherpa-onnx.node",
    "sherpa-onnx.node",
  ])
    assert.equal(existsSync(join(wrapper, name)), false, `Refuse shadowed/reused binding: ${name}`);
}

export function verifyStagedBinding(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json")));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.architecture, "arm64");
  assert.equal(manifest.electron, "44.6.0");
  assert.equal(manifest.sherpa, "1.13.8");
  assert.equal(manifest.onnxruntime, "1.28.2");
  assert.equal(manifest.sourceCommit, sourceCommit);
  assert.deepEqual(manifest.provenance, bindingProvenance(), "Pinned assembly provenance required");
  assert.ok(manifest.files.length >= 3);
  assert.equal(new Set(manifest.files.map((file) => file.name)).size, manifest.files.length);
  assert.ok(manifest.files.some((file) => file.name === "sherpa-onnx.node"));
  assert.ok(manifest.files.some((file) => file.name === "onnxruntime.dll"));
  assert.ok(manifest.files.some((file) => file.name === "sherpa-onnx-c-api.dll"));
  assert.deepEqual(
    readdirSync(directory).sort(),
    ["manifest.json", ...manifest.files.map((file) => file.name)].sort(),
  );
  for (const file of manifest.files) {
    assert.match(file.name, /^[a-zA-Z0-9_.-]+\.(node|dll)$/);
    const filename = join(directory, file.name);
    const stat = lstatSync(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, file.bytes);
    const bytes = readFileSync(filename);
    assert.equal(digest(bytes), file.sha256, file.name);
    assert.equal(inspectPe(bytes).machine, 0xaa64, file.name);
    if (file.name.endsWith(".node")) assertElectronArmBinding(bytes);
  }
  return manifest;
}

export function prepareArmBinding(repository, directory) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  const manifest = verifyStagedBinding(directory);
  const wrapper = join(repository, "node_modules/sherpa-onnx-node");
  assertWrapperTarget(wrapper);
  for (const file of manifest.files)
    cpSync(join(directory, file.name), join(wrapper, file.name), {
      errorOnExist: true,
      force: false,
    });
  return {
    asarUnpack: manifest.files.map((file) => `node_modules/sherpa-onnx-node/${file.name}`),
  };
}

export function verifyPackagedArmBinding(repository, appDirectory, directory) {
  const manifest = verifyStagedBinding(directory);
  const require = createRequire(join(repository, "package.json"));
  const { extractFile, listPackage, statFile } = require("@electron/asar");
  const archive = join(appDirectory, "resources/app.asar");
  const wrapper = "node_modules/sherpa-onnx-node";
  // fix: ASAR lookups require native separators; inventory comparisons below use POSIX.
  for (const [name, expected] of Object.entries(wrapperHashes))
    assert.equal(
      digest(extractFile(archive, join(wrapper, name))),
      expected,
      `Packaged loader ${name}`,
    );
  const inventory = new Set(
    listPackage(archive).map((name) => name.replaceAll("\\", "/").replace(/^\//, "")),
  );
  for (const name of [
    "node_modules/build/Release/sherpa-onnx.node",
    "node_modules/build/Debug/sherpa-onnx.node",
    `${wrapper}/node_modules/sherpa-onnx-win-arm64/sherpa-onnx.node`,
    "node_modules/sherpa-onnx-win-arm64/sherpa-onnx.node",
  ])
    assert.equal(inventory.has(name), false, `Packaged addon shadow: ${name}`);
  for (const file of manifest.files) {
    assert.equal(
      statFile(archive, join(wrapper, file.name)).unpacked,
      true,
      "Physical binding unpack required",
    );
    assert.equal(
      existsSync(join(appDirectory, file.name)),
      false,
      "No executable-root binding copy",
    );
    const filename = join(appDirectory, "resources/app.asar.unpacked", wrapper, file.name);
    assert.ok(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink());
    const bytes = readFileSync(filename);
    assert.equal(digest(bytes), file.sha256, `Packaged binding file ${file.name}`);
    assert.equal(inspectPe(bytes).machine, 0xaa64);
  }
  assert.equal(inspectPe(readFileSync(join(appDirectory, "Paseo.exe"))).machine, 0xaa64);
  return manifest;
}

export async function buildArmBinding(repository, root) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  repository = resolve(repository);
  root = resolve(root);
  assertWrapperTarget(join(repository, "node_modules/sherpa-onnx-node"));
  const hook = join(repository, "node_modules/node-gyp/src/win_delay_load_hook.cc");
  assert.equal(digest(readFileSync(hook)), delayHookHash, "Pinned delay-load hook");
  mkdirSync(root); // A new owned staging directory, never an existing cache/build.
  async function download({ name, url, sha256 }) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `${response.status}: ${url}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 300 * 1024 * 1024, "Bounded binding input required");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(digest(bytes), sha256, name);
    const filename = join(root, name);
    writeFileSync(filename, bytes, { flag: "wx" });
    return filename;
  }
  const [source, core, headers, importLibrary, addon] = await Promise.all(
    pinnedInputs.map(download),
  );
  const run = (command, args, timeout = 120000) =>
    execFileSync(command, args, { cwd: root, stdio: "inherit", timeout });
  const cpp = `${sourceRoot}/harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp`;
  run("tar", ["-xf", source, "-C", root, "--include", `${cpp}/*.cc`, "--include", `${cpp}/*.h`]);
  for (const archive of [core, headers, addon]) run("tar", ["-xf", archive, "-C", root]);
  cpSync(hook, join(root, "win_delay_load_hook.cc"));
  const build = join(root, "build");
  const cmakePath = (value) => value.replaceAll("\\", "/");
  run("cmake", [
    "-S",
    join(scriptDirectory, "windows-electron-binding"),
    "-B",
    build,
    "-G",
    "Visual Studio 18 2026",
    "-A",
    "ARM64",
    `-DBINDING_SOURCE=${cmakePath(join(root, cpp))}`,
    `-DSHERPA_CORE=${cmakePath(join(root, coreRoot))}`,
    `-DELECTRON_HEADERS=${cmakePath(join(root, "node_headers"))}`,
    `-DELECTRON_IMPORT_LIB=${cmakePath(importLibrary)}`,
    `-DADDON_API=${cmakePath(join(root, "package"))}`,
    `-DDELAY_LOAD_HOOK=${cmakePath(join(root, "win_delay_load_hook.cc"))}`,
  ]);
  run("cmake", ["--build", build, "--config", "Release", "--parallel", "2"], 600000);
  const output = join(root, "runtime");
  mkdirSync(output);
  cpSync(join(build, "Release/sherpa-onnx.node"), join(output, "sherpa-onnx.node"));
  const libraryDirectory = join(root, coreRoot, "lib");
  for (const name of readdirSync(libraryDirectory).filter((entry) => entry.endsWith(".dll")))
    cpSync(join(libraryDirectory, name), join(output, name));
  const manifest = {
    schema: 1,
    architecture: "arm64",
    electron: "44.6.0",
    sherpa: "1.13.8",
    onnxruntime: "1.28.2",
    sourceCommit,
    provenance: bindingProvenance(),
    assembly: "Locked wrapper local-addon fallback; core DLLs beside physically unpacked addon",
    files: readdirSync(output)
      .sort()
      .map((name) => {
        const bytes = readFileSync(join(output, name));
        return { name, bytes: bytes.length, sha256: digest(bytes) };
      }),
  };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest));
  verifyStagedBinding(output);
  return output;
}
