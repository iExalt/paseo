import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchCandidate, hashFile } from "./candidate-artifacts.mjs";
import processTree from "../../packages/desktop/e2e/process-tree.cjs";

const root = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-android-journey-"));
const harness = process.cwd();
const artifacts = resolve(".dev/github-workflows/native/android");
let producer;
let cli;
let env;
let identities = [];
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
try {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.arch, "arm64");
  assert.equal(process.platform, "linux");
  const harnessSha = run("git", ["rev-parse", "HEAD"]).trim();
  assert.equal(harnessSha, process.env.GITHUB_SHA);
  const pin = JSON.parse(process.env.CANDIDATE_PIN);
  const candidate = await fetchCandidate(
    pin,
    join(root, "candidate"),
    process.env.GH_TOKEN,
    "android",
  );
  await mkdir(artifacts, { recursive: true });
  const apk = join(
    root,
    "candidate/android",
    `paseo-iexalt-fork-${candidate.android.versionCode}.apk`,
  );
  const metadata = JSON.parse(
    await readFile(join(root, "candidate/android/build-metadata.json"), "utf8"),
  );
  assert.equal(metadata.kind, "paseo-verification-candidate");
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.platform, "android-arm64");
  assert.equal(metadata.sourceSha, candidate.sourceSha);
  assert.equal(metadata.forkVersion, candidate.forkVersion);
  assert.equal(String(metadata.versionCode), candidate.android.versionCode);
  assert.ok(!Object.hasOwn(metadata, "releaseSequence"));
  const certificates = [
    ...run("apksigner", ["verify", "--print-certs", apk]).matchAll(
      /^Signer #\d+ certificate SHA-256 digest: (\w+)$/gm,
    ),
  ];
  assert.equal(certificates.length, 1);
  assert.equal(certificates[0][1].toLowerCase(), candidate.android.signingCertificateSha256);
  const badging = run("aapt", ["dump", "badging", apk]);
  assert.ok(
    badging.includes(
      `package: name='sh.paseo.iexalt' versionCode='${candidate.android.versionCode}' versionName='${candidate.forkVersion}'`,
    ),
  );
  assert.match(badging, /^native-code: 'arm64-v8a'\s*$/m);
  const previous = join(root, "previous");
  await mkdir(previous);
  const tag = "paseo-fork-v0.11.0-r200008-5619b7d7ee1e55b322028e8b7818aa1a8f752a0a";
  for (const [name, maximum] of [
    ["paseo-release-manifest.json", 65536],
    ["paseo-release-manifest.sig", 1024],
    ["paseo-android-arm64.apk", 150000000],
  ]) {
    run(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-redirs",
        "3",
        "--max-time",
        "120",
        "--max-filesize",
        String(maximum),
        `https://github.com/iExalt/paseo/releases/download/${tag}/${name}`,
        "-o",
        join(previous, name),
      ],
      { timeout: 125000 },
    );
  }
  assert.equal(
    await hashFile(join(previous, "paseo-release-manifest.json")),
    "c6b43a85ea107c5060dc85143b74ede6d9180082a5bd5b069e6171019ba1b599",
  );
  run(process.execPath, [".github/scripts/verify-probe-apk.mjs", previous]);
  producer = join(root, "producer");
  run("git", ["worktree", "add", "--detach", producer, candidate.sourceSha]);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: producer }).trim(), candidate.sourceSha);
  env = {
    ...process.env,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    HOME: join(root, "home"),
    PASEO_HOME: join(root, "home"),
    npm_config_cache: join(root, "npm-cache"),
    LEFTHOOK: "0",
  };
  await mkdir(env.HOME);
  run("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: producer,
    env,
    timeout: 300000,
    stdio: "inherit",
  });
  run("npm", ["run", "build:server"], { cwd: producer, env, timeout: 180000, stdio: "inherit" });
  await writeFile(
    join(env.HOME, "config.json"),
    JSON.stringify({
      version: 1,
      daemon: {
        listen: "127.0.0.1:18767",
        relay: { enabled: false },
        mcp: { enabled: false, injectIntoAgents: false },
      },
      features: {
        webUi: { enabled: false },
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    }),
  );
  cli = join(producer, "packages/cli/dist/index.js");
  run(process.execPath, [cli, "daemon", "start", "--home", env.HOME], { cwd: producer, env });
  const pid = JSON.parse(await readFile(join(env.HOME, "paseo.pid"), "utf8")).pid;
  identities = processTree.captureProcessTree(pid);
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "Native ARM64 upgrade fixture\n");
  const workspace = JSON.parse(
    run(
      process.execPath,
      [
        cli,
        "workspace",
        "create",
        "--isolation",
        "local",
        "--path",
        project,
        "--title",
        "Persisted Android workspace",
        "--json",
      ],
      { cwd: producer, env },
    ),
  );
  await writeFile(
    join(artifacts, "identity.json"),
    JSON.stringify(
      {
        harnessSha,
        producer: pin,
        predecessorSourceSha: "5619b7d7ee1e55b322028e8b7818aa1a8f752a0a",
        predecessorVersion: "0.11.0",
        candidateVersion: candidate.forkVersion,
        candidate: candidate.android,
        workspace,
      },
      null,
      2,
    ),
  );
  run(
    "python3",
    [
      join(harness, ".github/scripts/android-candidate-ui.py"),
      join(previous, "paseo-android-arm64.apk"),
      apk,
      artifacts,
      "127.0.0.1:18767",
      candidate.android.versionCode,
    ],
    { env, timeout: 300000, stdio: "inherit" },
  );
} finally {
  try {
    if (cli) {
      identities = processTree.refreshProcessTree(identities);
      run(process.execPath, [cli, "daemon", "stop", "--home", env.HOME, "--force"], {
        cwd: producer,
        env,
      });
      await processTree.waitForProcessTreeExit(identities);
    }
  } finally {
    if (producer) run("git", ["worktree", "remove", "--force", producer]);
    await rm(root, { recursive: true, force: true });
  }
}
