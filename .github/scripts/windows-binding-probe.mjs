// Temporary diagnostic: remove after the packaged ARM binding failure is resolved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildArmBinding, digest, verifyStagedBinding } from "./windows-speech-binding.mjs";
import { inspectPe } from "./windows-pe.mjs";
import { windowsPathKey } from "./windows-path.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.arch, "arm64");
const [phase, root] = process.argv.slice(2);
assert.equal(
  resolve(root),
  resolve(
    process.env.RUNNER_TEMP,
    `paseo-windows-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  ),
);
const owner = JSON.parse(readFileSync(join(root, "owner.json")));
assert.equal(owner.sourceSha, process.env.GITHUB_SHA);
assert.equal(owner.architecture, process.arch);
const repository = process.env.GITHUB_WORKSPACE;
const evidence = join(root, "evidence");
const app = join(root, "Binding App With Spaces");
const executable = join(app, "Paseo.exe");
const staging = join(root, "binding/runtime");
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2), { flag: "wx" });
const physical = join(
  app,
  "resources/app.asar.unpacked/node_modules/sherpa-onnx-node/sherpa-onnx.node",
);

if (phase === "binding-build") {
  const inputs = join(root, "binding-inputs");
  const lockBytes = readFileSync(join(repository, "package-lock.json"));
  assert.equal(digest(lockBytes).toUpperCase(), owner.lockSha256.toUpperCase());
  const lock = JSON.parse(lockBytes);
  const sources = [];
  for (const [name, members] of [
    ["sherpa-onnx-node", ["package.json", "addon.js", "addon-static-import.js"]],
    ["node-gyp", ["src/win_delay_load_hook.cc"]],
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
    const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 10 * 1024 * 1024);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, entry.integrity);
    const archive = join(root, `${name}.tgz`);
    writeFileSync(archive, bytes, { flag: "wx" });
    const destination = join(inputs, "node_modules", name);
    mkdirSync(destination, { recursive: true });
    execFileSync(
      "tar.exe",
      [
        "-xf",
        archive,
        "--strip-components=1",
        "-C",
        destination,
        ...members.map((member) => `package/${member}`),
      ],
      { timeout: 30000, stdio: "inherit" },
    );
    sources.push({ name, version: entry.version, integrity: entry.integrity });
  }
  await buildArmBinding(inputs, join(root, "binding"));
  const manifest = verifyStagedBinding(staging);
  const require = createRequire(join(root, "fixture-tools/package.json"));
  assert.equal(require("electron/package.json").version, "44.6.0");
  execFileSync(process.execPath, [require.resolve("electron/install.js")], {
    timeout: 120000,
    stdio: "inherit",
  });
  const distribution = join(root, "fixture-tools/node_modules/electron/dist");
  assert.equal(readFileSync(join(distribution, "version"), "utf8").trim(), "44.6.0");
  assert.equal(inspectPe(readFileSync(join(distribution, "electron.exe"))).machine, 0xaa64);
  cpSync(join(root, "fixture-tools/node_modules/electron/dist"), app, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  renameSync(join(app, "electron.exe"), executable);
  assert.equal(inspectPe(readFileSync(executable)).machine, 0xaa64);
  const source = join(root, "binding-asar");
  const wrapper = join(source, "node_modules/sherpa-onnx-node");
  cpSync(join(inputs, "node_modules/sherpa-onnx-node"), wrapper, { recursive: true });
  for (const file of manifest.files) {
    assert.equal(existsSync(join(app, file.name)), false, `No executable-root copy: ${file.name}`);
    cpSync(join(staging, file.name), join(wrapper, file.name), {
      errorOnExist: true,
      force: false,
    });
  }
  const archive = join(app, "resources/app.asar");
  assert.equal(existsSync(archive), false);
  const { createPackageWithOptions, statFile } = require("@electron/asar");
  await createPackageWithOptions(source, archive, { unpack: "**/*.{node,dll}" });
  for (const file of manifest.files) {
    assert.equal(
      statFile(archive, join("node_modules", "sherpa-onnx-node", file.name)).unpacked,
      true,
    );
    assert.equal(digest(readFileSync(join(dirname(physical), file.name))), file.sha256);
  }
  save("binding-assembly.json", {
    sources,
    manifest,
    archiveWriter: require("@electron/asar/package.json").version,
    imports: Object.fromEntries(
      manifest.files.map((file) => [file.name, inspectPe(readFileSync(join(staging, file.name)))]),
    ),
  });
} else if (phase === "binding-runtime") {
  const manifest = verifyStagedBinding(staging);
  for (const file of manifest.files)
    assert.equal(existsSync(join(app, file.name)), false, `No executable-root copy: ${file.name}`);
  const script = join(root, "binding-load.cjs");
  writeFileSync(
    script,
    `
const fs = require('node:fs');
const result = { executable: process.execPath, versions: process.versions, architecture: process.arch };
try { const addon = require(process.argv[2]); result.onnxruntime = addon.onnxruntimeVersion; result.ok = true; }
catch (error) { result.ok = false; result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
result.sharedObjects = process.report.getReport().sharedObjects;
fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2), {flag:'wx'});
process.exitCode = result.ok ? 0 : 1;
`,
    { flag: "wx" },
  );
  function attempt(name, target) {
    const receipt = join(evidence, `binding-${name}.json`);
    const result = spawnSync(executable, [script, target, receipt], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30000,
      stdio: "inherit",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const loaded = JSON.parse(readFileSync(receipt));
    assert.equal(result.status, loaded.ok ? 0 : 1);
    return loaded;
  }
  const wrapper = attempt(
    "wrapper",
    join(app, "resources/app.asar/node_modules/sherpa-onnx-node/addon.js"),
  );
  if (!wrapper.ok) {
    attempt("physical", physical);
    throw new Error("Pinned wrapper failed; see independent wrapper and physical addon receipts");
  }
  assert.equal(wrapper.versions.electron, "44.6.0");
  assert.equal(wrapper.architecture, "arm64");
  assert.equal(wrapper.onnxruntime, "1.28.2");
  assert.equal(
    windowsPathKey(realpathSync(wrapper.executable)),
    windowsPathKey(realpathSync(executable)),
  );
  for (const file of manifest.files) {
    const loaded = wrapper.sharedObjects.filter(
      (filename) => basename(filename).toLowerCase() === file.name.toLowerCase(),
    );
    if (
      !loaded.length &&
      !["sherpa-onnx.node", "sherpa-onnx-c-api.dll", "onnxruntime.dll"].includes(file.name)
    )
      continue;
    assert.equal(loaded.length, 1, file.name);
    const expected = join(dirname(physical), file.name);
    assert.equal(windowsPathKey(realpathSync(loaded[0])), windowsPathKey(realpathSync(expected)));
    assert.equal(digest(readFileSync(loaded[0])), file.sha256);
  }
} else throw new Error(`Unknown binding diagnostic phase: ${phase}`);
