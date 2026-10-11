import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { verifyWindowsJob } from "./windows-job-identity.mjs";
import { inspectPe } from "./windows-pe.mjs";

const operation = process.argv[2];
assert.equal(verifyWindowsJob().stage, operation);
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
const root = join(
  process.env.RUNNER_TEMP,
  `paseo-windows-products-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
);
const repository = process.env.GITHUB_WORKSPACE;
const evidence = join(root, "evidence");
const appPath = join(root, "Installed App With Spaces");
const hash = (filename) => createHash("sha256").update(readFileSync(filename)).digest("hex");
const json = (filename) => JSON.parse(readFileSync(filename));
const save = (filename, data) => writeFileSync(filename, JSON.stringify(data), { flag: "wx" });
const owner = json(join(root, "owner.json"));
assert.equal(owner.sourceSha, process.env.GITHUB_SHA);
assert.equal(owner.architecture, process.arch);
const started = Date.now();

if (operation === "models") {
  const models = [
    {
      name: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
      category: "asr-models",
      bytes: 482468385,
      sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
    },
    {
      name: "kokoro-en-v0_19",
      category: "tts-models",
      bytes: 319625534,
      sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
    },
  ];
  mkdirSync(join(root, "models"));
  await Promise.all(
    models.map(async (model) => {
      const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${model.category}/${model.name}.tar.bz2`;
      const archive = join(root, `${model.name}.tar.bz2`);
      const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
      assert.equal(response.ok, true);
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source) {
          for await (const chunk of source) {
            received += chunk.length;
            assert.ok(received <= model.bytes);
            yield chunk;
          }
        },
        createWriteStream(archive, { flags: "wx" }),
      );
      assert.equal(received, model.bytes);
      assert.equal(hash(archive), model.sha256);
      execFileSync("tar.exe", ["-xf", archive, "-C", join(root, "models")], {
        timeout: 180000,
        stdio: "inherit",
      });
    }),
  );
  save(join(evidence, "models.json"), { models, elapsedMs: Date.now() - started });
} else if (operation.startsWith("inspect-")) {
  const stage = operation.slice("inspect-".length);
  const identity = json(join(root, `${stage}.json`));
  const files = { ...identity.payload };
  for (const item of identity.binding.files) {
    if (item.name.endsWith(".dll")) files[item.name] = item.sha256;
  }
  for (const [name, expected] of Object.entries(files))
    assert.equal(hash(join(appPath, name)), expected, name);
  assert.equal(
    inspectPe(readFileSync(join(appPath, "Paseo.exe"))).machine,
    process.arch === "arm64" ? 0xaa64 : 0x8664,
  );
  save(join(evidence, `${operation}.json`), {
    files,
    appPath,
    version: identity.version,
    elapsedMs: Date.now() - started,
  });
} else if (operation.startsWith("runtime-")) {
  const require = createRequire(import.meta.url);
  const {
    smokeInstalledWindowsStage,
  } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
  await smokeInstalledWindowsStage({
    stage: operation.slice("runtime-".length),
    root,
    appPath,
    artifactDir: join(evidence, operation),
  });
} else if (operation === "speech") {
  await speech();
} else throw new Error(`Unknown runtime operation ${operation}`);

async function speech() {
  const executable = join(appPath, "Paseo.exe");
  const resources = join(appPath, "resources");
  const runner = join(
    resources,
    "app.asar.unpacked",
    "dist",
    "daemon",
    "node-entrypoint-runner.js",
  );
  const worker = join(
    resources,
    "app.asar",
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "server",
    "server",
    "speech",
    "providers",
    "local",
    "worker-process.js",
  );
  const loaderReceipt = join(evidence, "speech-loader.json");
  const child = fork(runner, ["node-script", worker], {
    execPath: executable,
    execArgv: ["--require", join(repository, ".github/scripts/windows-speech-observe.cjs")],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PASEO_SPEECH_LOADER_RECEIPT: loaderReceipt },
  });
  let exitCode;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exitCode = code;
      resolve({ code, signal });
    });
  });
  const config = {
    modelsDir: join(root, "models"),
    voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
    dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
    voiceTtsModel: "kokoro-en-v0_19",
  };
  async function request(message) {
    const requestId = message.type;
    let timer;
    let listener;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          listener = (response) => {
            if (response.type !== "response" || response.requestId !== requestId) return;
            if (response.ok) resolve(response.result);
            else reject(new Error(response.error));
          };
          child.on("message", listener);
          timer = setTimeout(
            () => reject(new Error(`Speech request timed out: ${requestId}`)),
            120000,
          );
          child.send({ ...message, config, requestId }, (error) => {
            if (error) reject(error);
          });
        }),
        exited.then(() => {
          throw new Error(`Speech worker exited early: ${exitCode}`);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      child.off("message", listener);
    }
  }
  const { parsePcm16MonoWav, wordSimilarity } = await import(
    pathToFileURL(join(repository, "packages/server/src/server/test-utils/dictation-e2e.ts"))
  );
  const fixture = join(repository, "packages/app/e2e/support/fixtures");
  const { pcm16, sampleRate } = parsePcm16MonoWav(readFileSync(join(fixture, "recording.wav")));
  assert.equal(sampleRate, 16000);
  const audio = pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength);
  const stt = await request({
    type: "stt.transcribe",
    model: "dictation",
    audio,
    format: "audio/pcm;rate=16000",
  });
  const similarity = wordSimilarity(
    stt.text,
    readFileSync(join(fixture, "recording.baseline.txt"), "utf8"),
  );
  assert.ok(similarity > 0.45, `Real STT transcript similarity ${similarity}`);
  const tts = await request({ type: "tts.synthesize", text: "Paseo speech works." });
  const output = Buffer.from(tts.audio);
  assert.match(tts.format, /^pcm;rate=\d+$/);
  assert.ok(output.length > 1000 && output.length % 2 === 0);
  assert.ok(
    output.some((byte) => byte !== 0),
    "TTS must produce nonzero PCM",
  );
  child.disconnect();
  let closeTimer;
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => {
      closeTimer = setTimeout(
        () => reject(new Error("Speech worker did not close normally")),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(closeTimer));
  assert.deepEqual(result, { code: 0, signal: null });
  const loaded = json(loaderReceipt);
  assert.equal(loaded.code, 0);
  assert.equal(loaded.electron, "44.6.0");
  assert.equal(loaded.architecture, process.arch);
  assert.equal(loaded.onnxruntime, "1.28.2");
  assert.equal(
    realpathSync(loaded.executable).toLowerCase(),
    realpathSync(executable).toLowerCase(),
  );
  const binding = json(join(root, "candidate.json")).binding;
  assert.equal(loaded.addons.filter((filename) => filename.endsWith("sherpa-onnx.node")).length, 1);
  const modules = loaded.sharedObjects;
  const native = [];
  for (const expected of binding.files) {
    const matches = [
      ...new Set(
        modules
          .filter((filename) => basename(filename).toLowerCase() === expected.name.toLowerCase())
          .map((filename) => realpathSync(filename)),
      ),
    ];
    const required = ["sherpa-onnx.node", "sherpa-onnx-c-api.dll", "onnxruntime.dll"].includes(
      expected.name,
    );
    if (!required && matches.length === 0) continue;
    assert.equal(matches.length, 1, `One loaded ${expected.name}`);
    assert.ok(matches[0].toLowerCase().startsWith(`${realpathSync(appPath).toLowerCase()}\\`));
    assert.equal(hash(matches[0]), expected.sha256);
    native.push({ filename: matches[0], sha256: expected.sha256 });
  }
  save(join(evidence, "speech.json"), {
    executable,
    electron: loaded.electron,
    onnxruntime: loaded.onnxruntime,
    architecture: process.arch,
    native,
    transcript: stt.text,
    similarity,
    tts: { bytes: output.length, format: tts.format },
    elapsedMs: Date.now() - started,
  });
}
