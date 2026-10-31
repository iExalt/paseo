#!/usr/bin/env node
// Runs the unpackaged desktop app against a qa:web daemon, headless under Xvfb on Linux, and
// prints its CDP URL as one JSON line. See docs/agent-testing.md#desktop-sandbox.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { connectToPaseoRenderer } from "../e2e/support/connect-renderer.mjs";
import {
  SANDBOX_MARKER,
  checkSandboxDaemon,
  checkSandboxStopHome,
  hasSetuidSandbox,
  parseSandboxArgs,
  sandboxElectronEnv,
  sandboxLaunchCommand,
} from "./desktop-sandbox-config.mjs";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const qaWebScript = path.join(repoRoot, "scripts/qa-web.mjs");
const cliBin = path.join(repoRoot, "packages/cli/bin/paseo");

function log(message) {
  process.stderr.write(`[desktop:sandbox] ${message}\n`);
}

function qaWeb(args) {
  return execFileSync(process.execPath, [qaWebScript, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function supervisorPid(home) {
  const status = JSON.parse(
    execFileSync(process.execPath, [cliBin, "daemon", "status", "--home", home, "--json"], {
      encoding: "utf8",
      env: { ...process.env, PASEO_HOME: home },
    }),
  );
  return status.pid;
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

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Xvfb and Electron share the recorded process group; nothing is matched by name.
async function stopElectron(pid) {
  if (!pid || !groupAlive(pid)) return false;
  process.kill(-pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && groupAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
  return true;
}

async function start(args) {
  const startedAt = Date.now();
  if (!existsSync(path.join(desktopDir, "dist/main.js"))) {
    throw new Error(
      "Missing packages/desktop/dist/main.js. Run: npm run build:main --workspace=@getpaseo/desktop",
    );
  }
  const { default: electronPath } = await import("electron");
  const helper = path.join(path.dirname(electronPath), "chrome-sandbox");
  const setuidSandbox = hasSetuidSandbox(existsSync(helper) ? statSync(helper) : null);
  if (process.platform === "linux" && !setuidSandbox)
    log("chrome-sandbox is not setuid root; running with --no-sandbox");
  const launch = sandboxLaunchCommand({
    platform: process.platform,
    electronPath,
    appDir: desktopDir,
    allowWindow: args.allowWindow,
    setuidSandbox,
  });

  const qa = JSON.parse(qaWeb(args.seed ? ["--seed", args.seed] : []));
  const marker = path.join(qa.home, SANDBOX_MARKER);
  let electronPid = null;
  try {
    const cdpPort = await freePort();
    const rendererUrl = args.metro ?? qa.url;
    const daemonPid = supervisorPid(qa.home);
    const child = spawn(launch.command, launch.args, {
      cwd: desktopDir,
      env: sandboxElectronEnv(process.env, { home: qa.home, rendererUrl, cdpPort }),
      detached: true,
      stdio: [
        "ignore",
        openSync(path.join(qa.home, "electron.log"), "a"),
        openSync(path.join(qa.home, "electron.log"), "a"),
      ],
    });
    child.unref();
    electronPid = child.pid;
    writeFileSync(marker, `${JSON.stringify({ electronPid, cdpPort })}\n`);

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    const { page } = await connectToPaseoRenderer(cdpUrl, {
      origin: new URL(rendererUrl).origin,
      timeoutMs: 90_000,
    });
    // The app must have adopted the sandbox daemon, never another home such as ~/.paseo.
    const status = await page.evaluate(() =>
      window.paseoDesktop?.invoke?.("desktop_daemon_status"),
    );
    checkSandboxDaemon(status, qa);
    if (supervisorPid(qa.home) !== daemonPid) {
      throw new Error("The desktop app replaced the sandbox daemon instead of adopting it");
    }
    log(`the desktop app adopted the sandbox daemon in ${qa.home}`);

    process.stdout.write(
      `${JSON.stringify({
        cdpUrl,
        url: qa.url,
        renderer: rendererUrl,
        serverId: qa.serverId,
        home: qa.home,
        electronPid,
        readyMs: Date.now() - startedAt,
        ...(qa.seed ? { seed: qa.seed } : {}),
        stop: `npm run desktop:sandbox -- --stop ${qa.home}`,
      })}\n`,
    );
  } catch (error) {
    await stopElectron(electronPid);
    qaWeb(["--stop", qa.home]);
    throw error;
  }
}

async function stop(args) {
  const home = path.resolve(args.home);
  const marker = path.join(home, SANDBOX_MARKER);
  checkSandboxStopHome({ home, hasMarker: existsSync(marker) });
  const { electronPid, cdpPort } = JSON.parse(readFileSync(marker, "utf8"));
  const wasRunning = await stopElectron(electronPid);
  // The desktop app may stop its daemon on quit; qa:web --stop reports that as wasRunning:false.
  const daemon = JSON.parse(qaWeb(["--stop", home]));
  const leftovers = [
    groupAlive(electronPid) && `electron group ${electronPid}`,
    (await portAccepts(cdpPort)) && `CDP port ${cdpPort}`,
  ].filter(Boolean);
  if (leftovers.length > 0) throw new Error(`Still running after stop: ${leftovers.join(", ")}`);
  process.stdout.write(
    `${JSON.stringify({ stopped: home, electronWasRunning: wasRunning, daemonWasRunning: daemon.wasRunning })}\n`,
  );
}

try {
  const args = parseSandboxArgs(process.argv.slice(2));
  await (args.mode === "stop" ? stop(args) : start(args));
  // The CDP connection would keep this process alive; the sandbox runs on without it.
  process.exit(0);
} catch (error) {
  log(error.stderr?.toString().trim() || error.message);
  process.exit(1);
}
