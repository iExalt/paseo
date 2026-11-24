import { checkCallerEnvironment, prepareCallerFixture } from "./caller.mjs";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkBaseline, prepareBaseline, shellEnvironment } from "./baseline.mjs";
import { apiKey, assistantText, callId, model, sdkVersion, startBackend } from "./backend.mjs";
import { checkP5Interactions, prepareP5Fixture } from "./interactions.mjs";
import { checkOwnedRecovery } from "./owned-recovery.mjs";

const finishedUsage = {
  inputTokens: 12,
  cachedInputTokens: 2,
  cacheWriteTokens: 1,
  outputTokens: 3,
  reasoningTokens: 1,
  totalTokens: 15,
};

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? ".");
const [, , , mode, codex] = process.argv;
assert.ok(
  mode === "green" || mode === "baseline" || mode === "owner",
  "Expected green, baseline, or owner",
);
const require = createRequire(join(root, "packages/server/package.json"));
const sdkPackage = join(dirname(require.resolve("@cursor/sdk")), "../../package.json");
assert.equal(JSON.parse(await readFile(sdkPackage, "utf8")).version, sdkVersion);

const tmp = await mkdtemp(join(tmpdir(), "paseo-cursor-parity-"));
const workspace = join(tmp, "workspace");
const home = join(tmp, "home");
const paseoHome = join(tmp, "paseo");
const canary = "PASEO_LOCAL_CANARY";

await Promise.all([mkdir(workspace), mkdir(home), mkdir(paseoHome)]);
const useCallerFixture = mode === "owner" && process.platform === "linux";
const callerWorkspace = useCallerFixture
  ? await prepareCallerFixture({ root, paseoHome, home, workspace })
  : undefined;
const p5Fixture = useCallerFixture
  ? await prepareP5Fixture({ root, paseoHome, home, workspace })
  : undefined;
const backend = await startBackend(workspace, {
  p5: !!p5Fixture,
  inspectRequest: mode === "green",
  allowCodexPrewarm: mode === "baseline",
});
const codexProvider =
  mode === "baseline"
    ? await prepareBaseline(root, workspace, home, codex, backend.origin)
    : undefined;
await writeFile(
  join(workspace, "cursor-canary.sh"),
  [
    ...(mode === "baseline" ? shellEnvironment : []),
    ...(useCallerFixture
      ? [`if [ -n "\${P3_LABEL:-}" ]; then exec "${process.execPath}" p3-shell.mjs; fi`]
      : []),
    ...(mode === "green" || useCallerFixture
      ? ['printf "%s\\n" "${PASEO_HOME:-absent}" "${PASEO_CLI:-absent}" > cursor-cli-disabled.txt']
      : []),
    `printf '%s' '${canary}' > cursor-canary.txt`,
    `printf '%s' '${canary}'`,
  ].join("\n"),
);
await writeFile(
  join(paseoHome, "config.json"),
  JSON.stringify({
    agents: {
      resumeOnStartup: false,
      providers: {
        "cursor-sdk": {
          enabled: true,
          ...(mode === "green" ? { options: { cursor_model_reasoning_effort: "none" } } : {}),
        },
        codex: codexProvider,
      },
    },
  }),
);

const platformEnv =
  process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
        USERPROFILE: home,
        TEMP: tmp,
        TMP: tmp,
      }
    : {};
const shellPath =
  process.platform === "win32"
    ? [process.env.PASEO_WINDOWS_FIXTURE_SHELL_DIR, process.env.PATH]
        .filter(Boolean)
        .join(delimiter)
    : "/usr/bin:/bin";
const nodeCompileCache = process.env.NODE_COMPILE_CACHE || join(tmp, "node-compile-cache");
const env = {
  ...platformEnv,
  HOME: home,
  NODE_COMPILE_CACHE: nodeCompileCache,
  PATH: [dirname(process.execPath), shellPath].join(delimiter),
  SHELL: useCallerFixture ? "/bin/bash" : "/bin/sh",
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

async function startDaemon({ listen = env.PASEO_LISTEN, offline = false } = {}) {
  const daemonEnv = {
    ...env,
    PASEO_DEFER_TERMINAL_WORKER_LAUNCH: "1",
    PASEO_DISABLE_BUILTIN_PLUGINS: "1",
    ...(mode === "green" ? { PASEO_AGENT_ID: "stale-launcher" } : {}),
    PASEO_LISTEN: listen,
    ...(offline
      ? {
          CURSOR_API_KEY: "",
          CURSOR_API_BASE_URL: "http://127.0.0.1:1",
          CURSOR_BACKEND_URL: "http://127.0.0.1:1",
        }
      : {}),
  };
  child = fork(join(root, "packages/server/dist/server/server/daemon-worker.js"), {
    cwd: tmp,
    env:
      mode === "baseline"
        ? {
            ...daemonEnv,
            PASEO_AGENT_ID: "stale-launcher",
            PASEO_AGENT_CWD: "/stale-launcher",
            PASEO_WORKSPACE_ID: "stale-launcher",
            PARITY_STARTUP_ENV: "daemon-wide",
            PARITY_CODEX: codex,
          }
        : daemonEnv,
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
  const [code, exitSignal] = await finished;
  if (signal === "SIGKILL") {
    assert.ok(exitSignal === signal || (process.platform === "win32" && code !== 0));
  }
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
  assert.ok(items.every((item) => item.type !== "user_message" || item.cursorSkills === undefined));
  assert.deepEqual(
    items.filter((item) => item.type === "assistant_message").map(({ text }) => text),
    [assistantText],
  );
  const shells = items.filter((item) => item.type === "tool_call" && item.name === "shell");
  assert.equal(shells.length, 1);
  assert.ok(shells[0].callId.endsWith(`:${callId}`));
  assert.equal(shells[0].status, "completed");
  if (mode === "baseline") {
    const result = shells[0].detail.output;
    assert.equal(result?.status, "success");
    assert.equal(result.value.exitCode, 0);
    assert.equal(result.value.stdout, canary);
  } else {
    const shell = shells[0];
    assert.equal(shell.detail.type, "shell");
    assert.equal(shell.detail.command, "sh cursor-canary.sh");
    assert.equal(shell.detail.cwd, workspace);
    assert.equal(shell.detail.exitCode, 0);
    assert.equal(shell.detail.output, canary);
    assert.equal(shell.metadata.cursorSdk.output.value.stdout, canary);
    const reads = items.filter((item) => item.type === "tool_call" && item.name === "read");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].status, "completed");
    assert.deepEqual(reads[0].detail, {
      type: "read",
      filePath: join(workspace, "cursor-canary.sh"),
      content: "P8_READ_COMPLETED",
    });
  }
  assert.equal(await readFile(join(workspace, "cursor-canary.txt"), "utf8"), canary);
  const { snapshot } = await cli("agent", "status", run.agentId);
  if (mode === "baseline") {
    assert.deepEqual(snapshot.lastUsage, {
      inputTokens: 12,
      cachedInputTokens: 2,
      outputTokens: 3,
    });
  } else {
    const { tokenReadingTurnId, ...tokens } = snapshot.lastUsage;
    assert.ok(tokenReadingTurnId);
    assert.deepEqual(tokens, finishedUsage);
  }
  assert.equal(backend.runs, 1);
  assert.equal(backend.shellReplies, 1);
  console.log("PASS Cursor SDK shell canary, client tool result, assistant text, and usage");
}

const windowsOwnerReplay = mode === "owner" && process.platform === "win32";
let failure;
try {
  await startDaemon();
  const workspaceId = callerWorkspace ?? (await createWorkspace());
  const checkInteractions = (expectOwner) =>
    checkP5Interactions({
      require,
      listener: () => listener,
      paseoHome,
      workspace,
      workspaceId,
      fixtures: p5Fixture,
      model,
      expectOwner,
    });
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
  } else if (mode === "owner") {
    const caller = { root, require, paseoHome, workspace, workspaceId, listener: () => listener };
    const callerCanary = join(workspace, "cursor-canary.sh");
    const callerScript = await readFile(callerCanary);
    const callerAgents = useCallerFixture ? await checkCallerEnvironment(caller) : undefined;
    if (p5Fixture) await checkInteractions(true);
    await checkOwnedRecovery({
      backend,
      listener: () => listener,
      paseoHome,
      require,
      startDaemon,
      stopDaemon,
      workspace,
      workspaceId,
      canary,
    });
    if (callerAgents) {
      await writeFile(callerCanary, callerScript);
      await checkCallerEnvironment({ ...caller, agents: callerAgents });
    }
  } else {
    const completed = await launch(workspaceId, "Run the shell canary.");
    await checkCompleted(completed);
    assert.deepEqual(
      (await readFile(join(workspace, "cursor-cli-disabled.txt"), "utf8")).trimEnd().split("\n"),
      [paseoHome, "absent"],
    );
    await stopDaemon();
    await startDaemon();
    const { entries } = await cli("logs", completed.agentId);
    const items = entries.map(({ item }) => item);
    assert.deepEqual(
      items.filter((item) => item.type === "assistant_message").map(({ text }) => text),
      [assistantText],
    );
    assert.equal(
      items.filter((item) => item.type === "tool_call" && item.name === "shell").length,
      1,
    );
    console.log("PASS Cursor SDK cold replay across compiled daemon restart");
  }
} catch (error) {
  failure = { error };
  if (daemonLog) console.error(daemonLog);
} finally {
  try {
    try {
      await stopDaemon();
    } finally {
      try {
        await backend.close();
      } finally {
        await rm(tmp, {
          recursive: true,
          force: true,
          maxRetries: windowsOwnerReplay ? 5 : 0,
        });
      }
    }
  } catch (error) {
    if (failure && windowsOwnerReplay) console.error("Windows owner fixture cleanup failed", error);
    else failure = { error };
  }
}
if (failure) throw failure.error;
