import assert from "node:assert/strict";
import { assertNativeActor } from "./native-candidate-authority.mjs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildArmBinding,
  digest,
  prepareArmBinding,
  verifyPackagedArmBinding,
} from "./windows-speech-binding.mjs";
import { inspectPe } from "./windows-pe.mjs";
import { verifyWindowsJob } from "./windows-job-identity.mjs";
import { loadWindowsSources } from "./windows-product-sources.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
assert.ok(["x64", "arm64"].includes(process.arch));
assert.equal(process.version, "v26.11.0");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.GITHUB_REPOSITORY, "iExalt/paseo");
assert.equal(process.env.GITHUB_REF, "refs/heads/dev");
assertNativeActor(process.env);
assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT, /^\d+$/);
const controller = resolve(process.env.GITHUB_WORKSPACE);
const { candidate: repository, previous: previousSource } = loadWindowsSources();
const root = join(
  process.env.RUNNER_TEMP,
  `paseo-windows-products-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
);
const previousSha = "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a";
const operation = process.argv[2];
assert.equal(verifyWindowsJob().stage, operation);
const run = (executable, args, cwd = repository, timeout = 120000, env = process.env) =>
  execFileSync(executable, args, { cwd, timeout, stdio: "inherit", env });
const git = (source, ...args) =>
  execFileSync("git", args, { cwd: source, encoding: "utf8", timeout: 60000 }).trim();
const hash = (filename) => digest(readFileSync(filename));
const json = (filename) => JSON.parse(readFileSync(filename));
const save = (filename, value) =>
  writeFileSync(filename, JSON.stringify(value, null, 2), { flag: "wx" });
const npmEntry = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const npm = (source, args, timeout = 600000, env = process.env) =>
  run(process.execPath, [npmEntry, ...args], source, timeout, env);
const expectedMachine = process.arch === "arm64" ? 0xaa64 : 0x8664;
const ownerFile = join(root, "owner.json");

if (operation === "init") {
  // The stage monitor creates root/logs/evidence before launching this operation.
  assert.equal(existsSync(ownerFile), false);
  assert.equal(
    git(controller, "rev-parse", "HEAD"),
    process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
  );
  assert.equal(git(controller, "status", "--porcelain"), "");
  for (const name of ["packages", "state", "npm-cache"]) mkdirSync(join(root, name));
  if (repository !== controller)
    run(
      "git",
      [
        "worktree",
        "add",
        "--detach",
        repository,
        process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
      ],
      controller,
    );
  assert.equal(
    git(repository, "rev-parse", "HEAD"),
    process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
  );
  assert.equal(git(repository, "status", "--porcelain"), "");
  assert.equal(
    hash(join(repository, "package-lock.json")),
    hash(join(controller, "package-lock.json")),
  );
  run("git", ["worktree", "add", "--detach", previousSource, previousSha], controller);
  assert.equal(git(previousSource, "rev-parse", "HEAD"), previousSha);
  save(ownerFile, {
    sourceSha: process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
    architecture: process.arch,
    previousSha,
    candidateLock: hash(join(repository, "package-lock.json")),
    previousLock: hash(join(previousSource, "package-lock.json")),
  });
} else {
  const owner = json(ownerFile);
  assert.equal(owner.sourceSha, process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA);
  assert.equal(owner.architecture, process.arch);
  assert.equal(owner.previousSha, previousSha);
  if (operation === "install-candidate" || operation === "install-previous") {
    const stage = operation.slice("install-".length);
    const source = stage === "candidate" ? repository : previousSource;
    assert.equal(git(source, "status", "--porcelain"), "");
    assert.equal(json(join(dirname(npmEntry), "../package.json")).version, "11.20.0");
    const started = Date.now();
    // One run-local cache avoids downloading shared old/candidate inputs twice;
    // it is not uploaded to the repository's Actions cache.
    npm(source, ["ci", "--timing", "--foreground-scripts", "--no-audit", "--no-fund"], 1780000, {
      ...process.env,
      npm_config_cache: join(root, "npm-cache"),
    });
    assert.equal(hash(join(source, "package-lock.json")), owner[`${stage}Lock`]);
    save(join(root, "evidence", `${stage}-install.json`), {
      elapsedMs: Date.now() - started,
      lockSha256: owner[`${stage}Lock`],
    });
  } else if (operation === "binding") {
    // Exercise native ASAR path lookup before expensive compilation and packaging.
    run(
      process.execPath,
      ["--test", "--test-name-pattern=packaged binding", "scripts/windows-speech-binding.test.mjs"],
      repository,
      30000,
    );
    if (process.arch === "arm64") await buildArmBinding(repository, join(root, "binding"));
  } else if (operation === "build-candidate" || operation === "build-previous") {
    packageStage(operation.slice("build-".length), owner);
  } else throw new Error(`Unknown product build operation: ${operation}`);
}

function packageStage(stage, owner) {
  const source = stage === "candidate" ? repository : previousSource;
  const expectedSha = stage === "candidate" ? owner.sourceSha : previousSha;
  assert.equal(git(source, "rev-parse", "HEAD"), expectedSha);
  assert.equal(hash(join(source, "package-lock.json")), owner[`${stage}Lock`]);
  const require = createRequire(join(source, "package.json"));
  assert.equal(require("electron/package.json").version, "44.6.0");
  assert.equal(require("electron-builder/package.json").version, "26.15.3");
  assert.equal(require("sherpa-onnx-node/package.json").version, "1.13.8");
  const desktop = join(source, "packages/desktop");
  const metadata = json(join(desktop, "package.json"));
  assert.equal(
    metadata.version,
    stage === "previous" ? "0.11.0" : json(join(repository, "package.json")).version,
  );
  const config = require("js-yaml").load(
    readFileSync(join(desktop, "electron-builder.yml"), "utf8"),
  );
  assert.equal(config.appId, "sh.paseo.desktop");
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.perMachine, false);
  let binding;
  if (process.arch === "arm64") {
    const additions = prepareArmBinding(source, join(root, "binding/runtime"));
    config.asarUnpack = [...(config.asarUnpack ?? []), ...additions.asarUnpack];
  } else {
    const packageDirectory = dirname(require.resolve("sherpa-onnx-win-x64/package.json"));
    assert.equal(json(join(packageDirectory, "package.json")).version, "1.13.8");
    const files = readdirSync(packageDirectory).filter((name) => /\.(node|dll)$/.test(name));
    assert.ok(files.includes("sherpa-onnx.node") && files.includes("onnxruntime.dll"));
    binding = {
      architecture: "x64",
      sherpa: "1.13.8",
      source: "locked sherpa-onnx-win-x64 package",
      files: files.map((name) => {
        const bytes = readFileSync(join(packageDirectory, name));
        assert.equal(inspectPe(bytes).machine, expectedMachine);
        return { name, sha256: digest(bytes), bytes: bytes.length };
      }),
    };
    config.asarUnpack = [...(config.asarUnpack ?? []), "node_modules/sherpa-onnx-win-x64/**/*"];
    config.extraFiles = [
      ...(config.extraFiles ?? []),
      ...files
        .filter((name) => name.endsWith(".dll"))
        .map((name) => ({ from: join(packageDirectory, name), to: name })),
    ];
  }
  const output = join(root, "packages", stage);
  config.directories.output = output;
  config.win.target = [{ target: "nsis", arch: [process.arch] }];
  config.win.artifactName = `${stage}-${process.arch}.exe`;
  const configFile = join(root, `${stage}-builder.json`);
  save(configFile, config);
  const started = Date.now();
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", PASEO_DESKTOP_SMOKE: "0" };
  npm(source, ["run", "build:app-deps:clean"], 600000, env);
  run(
    process.execPath,
    [require.resolve("expo/bin/cli"), "export", "--platform", "web"],
    join(source, "packages/app"),
    600000,
    { ...env, PASEO_WEB_PLATFORM: "electron" },
  );
  npm(source, ["run", "build:server:clean"], 600000, env);
  npm(source, ["run", "build:main", "--workspace=@getpaseo/desktop"], 600000, env);
  run(
    process.execPath,
    [
      require.resolve("electron-builder/cli.js"),
      "--projectDir",
      desktop,
      "--config",
      configFile,
      "--win",
      "nsis",
      `--${process.arch}`,
      "--publish",
      "never",
    ],
    desktop,
    600000,
    // fix: the locked NSIS decoder cannot decode automatic ARM64 filters (#9983).
    { ...env, ELECTRON_BUILDER_7Z_FILTER: "BCJ" },
  );
  const payload = join(output, process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked");
  const { extractFile, listPackage } = require("@electron/asar");
  const inventory = listPackage(join(payload, "resources/app.asar"));
  const relevant = inventory
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => /sherpa|worker-process|node-entrypoint/.test(name));
  save(join(root, "evidence", `${stage}-speech-layout.json`), {
    totalEntries: inventory.length,
    relevantEntries: relevant.length,
    truncated: relevant.length > 500 || relevant.some((name) => name.length > 1024),
    entries: relevant.slice(0, 500).map((name) => name.slice(0, 1024)),
  });
  assert.equal(inspectPe(readFileSync(join(payload, "Paseo.exe"))).machine, expectedMachine);
  if (process.arch === "arm64")
    binding = verifyPackagedArmBinding(source, payload, join(root, "binding/runtime"));
  else
    for (const file of binding.files) {
      const packaged = join(
        payload,
        "resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64",
        file.name,
      );
      assert.equal(hash(packaged), file.sha256);
      if (file.name.endsWith(".dll")) assert.equal(hash(join(payload, file.name)), file.sha256);
    }
  assert.equal(
    JSON.parse(extractFile(join(payload, "resources/app.asar"), "package.json")).version,
    metadata.version,
  );
  if (stage === "candidate" && process.arch === "arm64") {
    // fix: reject loader/ABI failures before the expensive predecessor install.
    run(
      join(payload, "Paseo.exe"),
      [
        "-e",
        "const a=require('node:assert/strict'); a.equal(process.versions.electron,'44.6.0'); a.equal(process.arch,'arm64'); a.equal(require(process.argv[1]).onnxruntimeVersion,'1.28.2'); console.log('Packaged ARM wrapper loaded normally');",
        join(payload, "resources/app.asar/node_modules/sherpa-onnx-node/addon.js"),
      ],
      source,
      30000,
      { ...env, ELECTRON_RUN_AS_NODE: "1" },
    );
  }
  const installer = join(output, `${stage}-${process.arch}.exe`);
  const identity = {
    sourceSha: expectedSha,
    lockSha256: owner[`${stage}Lock`],
    version: metadata.version,
    architecture: process.arch,
    reconstruction:
      stage === "previous"
        ? "Fixed source rebuilt with documented current binding and NSIS assembly"
        : null,
    appId: config.appId,
    archiveFilter: "BCJ",
    binding,
    payload: Object.fromEntries(
      [
        "Paseo.exe",
        "resources/app.asar",
        "resources/bin/paseo.cmd",
        "resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
      ].map((name) => [name, hash(join(payload, name))]),
    ),
    installer: { filename: installer, sha256: hash(installer), bytes: statSync(installer).size },
    elapsedMs: Date.now() - started,
  };
  assert.equal(
    readdirSync(output).some((name) => name.endsWith(".zip")),
    false,
    "No Windows ZIP output",
  );
  assert.equal(hash(join(source, "package-lock.json")), owner[`${stage}Lock`]);
  save(join(root, `${stage}.json`), identity);
  save(join(root, "evidence", `${stage}-packaging.json`), identity);
}
