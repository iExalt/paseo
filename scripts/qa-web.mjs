#!/usr/bin/env node
// Starts an isolated daemon that serves the web UI with only the mock provider, for agents
// checking the app in a browser. Prints one JSON line on stdout; progress goes to stderr.
// See docs/agent-testing.md#isolated-daemons.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "./is-main-module.mjs";
import {
  buildQaWebConfig,
  builtinPluginProviderIds,
  checkQaWebHome,
  checkQaWebStopHome,
  parseQaWebArgs,
  qaWebEnv,
  QA_WEB_MARKER,
  QA_WEB_PROVIDER,
} from "./qa-web-config.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "packages/cli/bin/paseo");
const protocolManifest = path.join(repoRoot, "packages/protocol/dist/provider-manifest.js");
const builtinPluginList = path.join(
  repoRoot,
  "packages/server/dist/server/server/plugins/builtin/index.js",
);
const SEED_MODEL = "ten-second-stream";
// A 1×1 PNG, so the seeded image renders without a network fetch.
const SEED_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SEED_AGENTS = [
  { title: "Realistic turn", prompt: "Fix the scroll jump when dragging the list" },
  { title: "Tool calls", prompt: "emit 60 tool agent stream updates" },
  { title: "Image", prompt: `emit settled assistant image markdown: ![qa](${SEED_IMAGE})` },
];

function log(message) {
  process.stderr.write(`[qa:web] ${message}\n`);
}

function preflight() {
  const required = [
    [cliBin.replace(/bin\/paseo$/, "dist/index.js"), "npm run build:server"],
    [protocolManifest, "npm run build:server"],
    [builtinPluginList, "npm run build:server"],
    [
      path.join(repoRoot, "packages/server/dist/server/web-ui/index.html"),
      "npm run build:daemon-web-ui",
    ],
  ];
  const missing = required.filter(([file]) => !existsSync(file));
  if (missing.length > 0) {
    const commands = [...new Set(missing.map(([, command]) => command))];
    throw new Error(
      `Missing build output:\n${missing.map(([file]) => `  ${path.relative(repoRoot, file)}`).join("\n")}\nRun: ${commands.join(" && ")}`,
    );
  }
}

// Every provider the daemon can register, including built-in plugins' providers, so they are
// disabled before the daemon would probe their CLIs and accounts.
async function registeredProviderIds() {
  const manifest = await import(pathToFileURL(protocolManifest).href);
  const { builtinPlugins } = await import(pathToFileURL(builtinPluginList).href);
  return [
    ...[...manifest.AGENT_PROVIDER_DEFINITIONS, ...manifest.DEV_AGENT_PROVIDER_DEFINITIONS].map(
      (definition) => definition.id,
    ),
    ...builtinPluginProviderIds(builtinPlugins),
  ];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function paseo(home, args) {
  const { stdout } = await run(process.execPath, [cliBin, ...args, "--home", home, "--json"], {
    env: qaWebEnv(process.env, home),
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function startDaemon(home, port, providerIds) {
  writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(buildQaWebConfig({ port, providerIds }), null, 2)}\n`,
  );
  return await paseo(home, ["daemon", "start", "--timeout", "120"]);
}

async function seedHeavy(home) {
  const workspace = path.join(home, "workspace");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "README.md"), "# qa:web workspace\n");
  writeFileSync(path.join(workspace, "src/list.tsx"), "export const items = [1, 2, 3];\n");
  const git = (...args) =>
    run("git", ["-c", "user.name=qa", "-c", "user.email=qa@localhost", ...args], {
      cwd: workspace,
    });
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "seed");

  const results = await Promise.allSettled(
    SEED_AGENTS.map(({ title, prompt }) =>
      paseo(home, [
        "agent",
        "run",
        "--provider",
        QA_WEB_PROVIDER,
        "--model",
        SEED_MODEL,
        "--cwd",
        workspace,
        "--title",
        title,
        prompt,
      ]),
    ),
  );
  const agents = [];
  const missing = [];
  results.forEach((result, index) => {
    const { title } = SEED_AGENTS[index];
    if (result.status === "fulfilled")
      agents.push({ title, id: result.value.id ?? result.value.agentId });
    else missing.push({ title, error: String(result.reason?.stderr || result.reason).trim() });
  });
  return { agents, missing };
}

async function start(args) {
  const startedAt = Date.now();
  preflight();
  const providerIds = await registeredProviderIds();
  let port = args.port ?? (await freePort());
  const home = path.resolve(args.home ?? path.join(repoRoot, ".dev/qa-web", String(port)));
  for (const warning of checkQaWebHome({
    home,
    env: process.env,
    hasConfig: existsSync(path.join(home, "config.json")),
    reuse: args.reuse,
  })) {
    log(warning);
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, QA_WEB_MARKER), "");

  log(`starting a daemon in ${home}`);
  let launch;
  try {
    launch = await startDaemon(home, port, providerIds);
  } catch (error) {
    // Another process can take a probed port before the daemon binds it.
    if (args.port || !String(error.stderr ?? error).includes("EADDRINUSE")) throw error;
    port = await freePort();
    log(`port taken; retrying on ${port}`);
    launch = await startDaemon(home, port, providerIds);
  }
  const status = await paseo(home, ["daemon", "status"]);
  const readyMs = Date.now() - startedAt;

  let seed;
  if (args.seed) {
    log("seeding agents");
    const seedStartedAt = Date.now();
    seed = { ...(await seedHeavy(home)), ms: Date.now() - seedStartedAt };
  }

  const output = {
    url: `http://127.0.0.1:${port}/`,
    serverId: status.serverId,
    home,
    pid: launch.pid,
    workerPid: status.workerPid,
    readyMs,
    providers: (status.providers ?? []).map((provider) => provider.provider),
    ...(seed ? { seed } : {}),
    stop: `npm run qa:web -- --stop ${home}`,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function stop(args) {
  const home = path.resolve(args.home);
  checkQaWebHome({ home, env: process.env, hasConfig: false, reuse: true });
  checkQaWebStopHome({ home, hasMarker: existsSync(path.join(home, QA_WEB_MARKER)) });
  const status = await paseo(home, ["daemon", "status"]);
  if (!status.pid) {
    process.stdout.write(`${JSON.stringify({ stopped: home, wasRunning: false })}\n`);
    return;
  }
  const port =
    Number(
      String(status.listen ?? "")
        .split(":")
        .pop(),
    ) || null;
  await paseo(home, ["daemon", "stop"]);
  const findLeftovers = async () =>
    [
      processAlive(status.pid) && `supervisor ${status.pid}`,
      processAlive(status.workerPid) && `worker ${status.workerPid}`,
      port && (await portAccepts(port)) && `port ${port}`,
    ].filter(Boolean);
  let leftovers = await findLeftovers();
  for (let attempt = 0; leftovers.length > 0 && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    leftovers = await findLeftovers();
  }
  if (leftovers.length > 0) throw new Error(`Still running after stop: ${leftovers.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ stopped: home, wasRunning: true })}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseQaWebArgs(process.argv.slice(2));
    await (args.mode === "stop" ? stop(args) : start(args));
  } catch (error) {
    log(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  }
}
