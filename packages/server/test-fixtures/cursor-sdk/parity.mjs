import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkBaseline, prepareBaseline, shellEnvironment } from "./baseline.mjs";
import { apiKey, assistantText, callId, model, sdkVersion, startBackend } from "./backend.mjs";

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? ".");
const [, , , mode, codex] = process.argv;
assert.ok(mode === "green" || mode === "baseline", "Expected green or baseline");
const require = createRequire(join(root, "packages/server/package.json"));
const sdkPackage = join(dirname(require.resolve("@cursor/sdk")), "../../package.json");
assert.equal(JSON.parse(await readFile(sdkPackage, "utf8")).version, sdkVersion);

const tmp = await mkdtemp(join(tmpdir(), "paseo-cursor-parity-"));
const workspace = join(tmp, "workspace");
const home = join(tmp, "home");
const paseoHome = join(tmp, "paseo");
const canary = "PASEO_LOCAL_CANARY";

await Promise.all([mkdir(workspace), mkdir(home), mkdir(paseoHome)]);
const backend = await startBackend(workspace, { allowCodexPrewarm: mode === "baseline" });
const codexProvider =
  mode === "baseline"
    ? await prepareBaseline(root, workspace, home, codex, backend.origin)
    : undefined;
await writeFile(
  join(workspace, "cursor-canary.sh"),
  [
    ...(mode === "baseline" ? shellEnvironment : []),
    `printf '%s' '${canary}' > cursor-canary.txt`,
    `printf '%s' '${canary}'`,
  ].join("\n"),
);
await writeFile(
  join(paseoHome, "config.json"),
  JSON.stringify({
    agents: {
      resumeOnStartup: false,
      providers: { "cursor-sdk": { enabled: true }, codex: codexProvider },
    },
  }),
);

const env = {
  HOME: home,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  SHELL: "/bin/sh",
  PASEO_HOME: paseoHome,
  PASEO_LISTEN: "127.0.0.1:0",
  PASEO_RELAY_ENABLED: "false",
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  CURSOR_API_KEY: apiKey,
  CURSOR_API_BASE_URL: backend.origin,
  CURSOR_BACKEND_URL: backend.origin,
};

let child;
let daemonLog = "";
let listener;

async function startDaemon() {
  child = fork(join(root, "packages/server/dist/server/server/daemon-worker.js"), {
    cwd: workspace,
    env:
      mode === "baseline"
        ? {
            ...env,
            PASEO_AGENT_ID: "stale-launcher",
            PASEO_AGENT_CWD: "/stale-launcher",
            PASEO_WORKSPACE_ID: "stale-launcher",
            PARITY_STARTUP_ENV: "daemon-wide",
            PARITY_CODEX: codex,
          }
        : env,
    silent: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      daemonLog = (daemonLog + chunk).slice(-12000);
    });
  }
  const deadline = AbortSignal.timeout(10000);
  while (true) {
    const [message] = await once(child, "message", { signal: deadline });
    if (message.type === "paseo:ready") {
      assert.match(message.listen, /^127\.0\.0\.1:\d+$/);
      listener = message.listen;
      return;
    }
  }
}

async function stopDaemon(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  assert.ok(child.kill(signal), "Unable to signal fixture daemon");
  const [, exitSignal] = await finished;
  if (signal === "SIGKILL") assert.equal(exitSignal, signal);
}

async function cli(...args) {
  const { stdout } = await exec(
    process.execPath,
    [join(root, "packages/cli/bin/paseo"), "--host", listener, ...args, "--json"],
    { cwd: workspace, env, timeout: 18000 },
  );
  return JSON.parse(stdout);
}

async function createWorkspace() {
  const project = await cli("project", "create", workspace);
  const result = await cli(
    "workspace",
    "create",
    "--isolation",
    "local",
    "--no-background",
    "--project",
    project.id ?? project.projectId,
    "--path",
    workspace,
    "--notifications",
    "off",
  );
  assert.ok(result.workspaceId);
  return result.workspaceId;
}

function launch(workspaceId, prompt, ...flags) {
  return cli(
    "run",
    "--workspace",
    workspaceId,
    "--relationship",
    "detached",
    "--no-notify-on-finish",
    "--provider",
    "cursor-sdk",
    "--model",
    model,
    "--mode",
    "unrestricted",
    "--wait-timeout",
    "12s",
    "--prompt",
    prompt,
    ...flags,
  );
}

async function checkCompleted(run) {
  assert.equal(run.status, "completed");
  const { entries } = await cli("logs", run.agentId);
  const items = entries.map(({ item }) => item);
  assert.deepEqual(
    items.filter((item) => item.type === "assistant_message").map(({ text }) => text),
    [assistantText],
  );
  const shells = items.filter((item) => item.type === "tool_call" && item.name === "shell");
  assert.equal(shells.length, 1);
  assert.ok(shells[0].callId.endsWith(`:${callId}`));
  assert.equal(shells[0].status, "completed");
  const result = shells[0].detail.output;
  assert.equal(result?.status, "success");
  assert.equal(result.value.exitCode, 0);
  assert.equal(result.value.stdout, canary);
  assert.equal(await readFile(join(workspace, "cursor-canary.txt"), "utf8"), canary);
  const { snapshot } = await cli("agent", "status", run.agentId);
  assert.deepEqual(snapshot.lastUsage, { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3 });
  assert.equal(backend.runs, 1);
  assert.equal(backend.shellReplies, 1);
  console.log("PASS Cursor SDK shell canary, client tool result, assistant text, and usage");
}

try {
  await startDaemon();
  const workspaceId = await createWorkspace();
  if (mode === "baseline") {
    await checkBaseline({
      backend,
      cli,
      home,
      launch,
      listener: () => listener,
      paseoHome,
      require,
      startDaemon,
      stopDaemon,
      workspace,
      workspaceId,
      checkCompleted,
    });
  } else {
    await checkCompleted(await launch(workspaceId, "Run the shell canary."));
  }
} catch (error) {
  if (daemonLog) console.error(daemonLog);
  throw error;
} finally {
  try {
    await stopDaemon();
  } finally {
    try {
      await backend.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
