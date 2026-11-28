const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { extractFile } = require("@electron/asar");
const { WebSocket } = require("ws");
const assert = require("node:assert/strict");
const { terminalHookCommand, hasTerminalOutput } = require("./terminal-proof.cjs");

const EXECUTABLE_NAME = "Paseo";
const SMOKE_TIMEOUT_MS = 60_000;
const DAEMON_STATUS_CALL_TIMEOUT_MS = 10_000;
const ARTIFACT_PAGE_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 10_000;
const TERMINAL_CAPTURE_ATTEMPTS = 20;
const TERMINAL_CAPTURE_INTERVAL_MS = 500;
const REQUIRED_DESKTOP_BRIDGE_KEYS = [
  "platform",
  "invoke",
  "getPendingOpenProject",
  "events",
  "window",
  "dialog",
  "notification",
  "opener",
  "editor",
  "webUtils",
  "menu",
  "browser",
];

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function assertBuiltinPluginsStarted(listen) {
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { builtinPlugins } =
    await import("../../server/dist/server/server/plugins/builtin/index.js");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "packaged-builtin-smoke",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    assert.deepEqual(
      catalog.map(({ id }) => id).sort(),
      [...builtinPlugins].sort(),
      "Every built-in plugin must start in the packaged desktop daemon",
    );
  } finally {
    await client.close();
  }
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (process.platform !== "win32") {
    fs.accessSync(filePath, fs.constants.X_OK);
  }
}

function getExecutablePath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
  }

  if (process.platform === "win32") {
    return path.join(appPath, `${EXECUTABLE_NAME}.exe`);
  }

  return path.join(appPath, EXECUTABLE_NAME);
}

function getCliShimPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "paseo");
  }

  if (process.platform === "win32") {
    return path.join(appPath, "resources", "bin", "paseo.cmd");
  }

  return path.join(appPath, "resources", "bin", "paseo");
}

function getMacMainExecutablePath(appPath) {
  return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
}

function getLaunchCommand(executablePath, args) {
  if (process.platform !== "linux") {
    return {
      command: executablePath,
      args,
    };
  }

  return {
    command: "xvfb-run",
    args: ["-a", "--server-args=-screen 0 1280x800x24", executablePath, ...args],
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteCliArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  return shellQuote(String(value));
}

function getShellCommand(script) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", script],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", script],
  };
}

function createDefaultDaemonEnv(extraEnv) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    ...extraEnv,
  };
}

function createIsolatedDesktopEnv({ home, listen, userData, cdpPort }) {
  return {
    ...createDefaultDaemonEnv({ HOME: home, USERPROFILE: home }),
    PASEO_HOME: home,
    PASEO_LISTEN: listen,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  };
}

function configureIsolatedDaemonHome(home, listen) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        daemon: {
          listen,
          relay: { enabled: false },
          mcp: { enabled: false, injectIntoAgents: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function reserveLocalTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a TCP port for smoke test")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForFile(filePath, label) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const contents = fs.readFileSync(filePath, "utf8");
      if (contents.trim().length > 0) {
        return contents;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForChildPids(parentPid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const childPids = listChildPids(parentPid);
    if (childPids.length > 0) {
      return childPids;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for daemon worker child of supervisor PID ${parentPid}`);
}

function listChildPids(parentPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ps failed while listing child processes: ${result.stderr.trim()}`);
  }

  const children = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && ppid === parentPid) {
      children.push(pid);
    }
  }
  return children;
}

function listDarwinTextExecutables(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `lsof failed while inspecting PID ${pid}: ${
        result.stderr.trim() || result.stdout.trim() || "<empty>"
      }`,
    );
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function assertDarwinProcessDoesNotUseMainAppExecutable({ appPath, pid, label }) {
  const mainExecutablePath = getMacMainExecutablePath(appPath);
  assertExecutable(mainExecutablePath, "Packaged app executable");

  const textExecutables = listDarwinTextExecutables(pid);
  if (textExecutables.includes(mainExecutablePath)) {
    throw new Error(
      `${label} PID ${pid} launched through the main app executable ${mainExecutablePath}.\nText executables:\n${textExecutables.join(
        "\n",
      )}`,
    );
  }
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function captureProcessList() {
  if (process.platform === "win32") {
    return null;
  }

  const result = spawnSync("ps", ["-axo", "pid,ppid,%cpu,%mem,rss,state,comm,args"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    return `<ps error: ${result.error.message}>`;
  }
  if (result.status !== 0) {
    return `<ps exited ${result.status}: ${result.stderr.trim() || "<empty>"}>`;
  }
  return result.stdout.trim();
}

function captureVmStat() {
  if (process.platform !== "darwin") {
    return null;
  }

  const result = spawnSync("vm_stat", [], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    return `<vm_stat error: ${result.error.message}>`;
  }
  if (result.status !== 0) {
    return `<vm_stat exited ${result.status}: ${result.stderr.trim() || "<empty>"}>`;
  }
  return result.stdout.trim();
}

function extractPaseoElectronPids(processList) {
  if (!processList) {
    return [];
  }

  const pids = [];
  for (const line of processList.split(/\r?\n/).slice(1)) {
    if (!line.includes("Paseo.app/Contents/")) {
      continue;
    }
    const match = line.trim().match(/^(\d+)\s+/);
    if (match) {
      pids.push(Number(match[1]));
    }
  }
  return pids.slice(0, 6);
}

function captureDarwinSamples(artifactDir, processList) {
  if (process.platform !== "darwin") {
    return;
  }

  for (const pid of extractPaseoElectronPids(processList)) {
    const result = spawnSync("sample", [String(pid), "1"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = result.error
      ? `<sample error for pid ${pid}: ${result.error.message}>`
      : [result.stdout, result.stderr].filter(Boolean).join("\n");
    fs.writeFileSync(path.join(artifactDir, `sample-${pid}.txt`), `${output}\n`);
  }
}

function filterRelevantProcesses(processList) {
  if (!processList) {
    return null;
  }

  const lines = processList.split(/\r?\n/);
  const header = lines[0] ?? "";
  const matching = lines.slice(1).filter((line) => /paseo|node/i.test(line));
  return [header, ...matching].filter(Boolean).join("\n") || "<none>";
}

function raceWithTimeout(promise, timeoutMs, label) {
  // Prevent unhandled rejections if the inner promise rejects after the timeout wins.
  promise.catch(() => undefined);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

function formatLogs({
  stdout,
  stderr,
  userData,
  daemonHome,
  processList = captureProcessList(),
  vmStat = captureVmStat(),
}) {
  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  const relevantProcesses = filterRelevantProcesses(processList);
  return [
    `App stdout:\n${stdout.join("").trim() || "<empty>"}`,
    `App stderr:\n${stderr.join("").trim() || "<empty>"}`,
    `Desktop log:\n${desktopLog?.trim() || "<missing>"}`,
    `Daemon log:\n${daemonLog?.trim() || "<missing>"}`,
    `Live processes (paseo|node):\n${relevantProcesses || "<unavailable>"}`,
    ...(vmStat !== null ? [`vm_stat:\n${vmStat}`] : []),
  ].join("\n\n");
}

async function writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome, error }) {
  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }

  const processList = captureProcessList();
  const vmStat = captureVmStat();
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, error ? "failure.txt" : "success.txt"),
    `${error instanceof Error ? (error.stack ?? error.message) : String(error ?? "Packaged desktop smoke passed")}\n\n${formatLogs(
      {
        stdout,
        stderr,
        userData,
        daemonHome,
        processList,
        vmStat,
      },
    )}\n`,
  );

  if (processList !== null) {
    fs.writeFileSync(path.join(artifactDir, "ps.txt"), `${processList}\n`);
  }
  if (vmStat !== null) {
    fs.writeFileSync(path.join(artifactDir, "vm_stat.txt"), `${vmStat}\n`);
  }
  if (error) {
    captureDarwinSamples(artifactDir, processList);
  }
  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  if (desktopLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "desktop-main.log"), desktopLog);
  }
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  if (daemonLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "daemon.log"), daemonLog);
  }

  if (page) {
    const renderer = await raceWithTimeout(
      page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        rootChildCount: document.querySelector("#root")?.childElementCount ?? 0,
        rootText: document.querySelector("#root")?.textContent?.trim().slice(0, 2_000) ?? "",
        bridgeKeys:
          typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
            ? Object.keys(window.paseoDesktop)
            : [],
      })),
      ARTIFACT_PAGE_TIMEOUT_MS,
      "renderer artifact capture",
    ).catch((evaluationError) => ({ evaluationError: String(evaluationError) }));
    fs.writeFileSync(
      path.join(artifactDir, "renderer.json"),
      `${JSON.stringify(renderer, null, 2)}\n`,
    );
    await raceWithTimeout(
      page.screenshot({ path: path.join(artifactDir, "renderer.png"), fullPage: true }),
      ARTIFACT_PAGE_TIMEOUT_MS,
      "renderer screenshot capture",
    ).catch(() => undefined);
  }
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!isRunning(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  child.kill(signal);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (!isRunning(child)) {
    return Promise.resolve(true);
  }

  let onExit;
  const exitPromise = new Promise((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });

  return Promise.race([exitPromise, delay(timeoutMs, false)]).finally(() => {
    child.off("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function removeTempDir(tempDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        console.warn(`Packaged desktop smoke: failed to remove temp dir ${tempDir}: ${error}`);
        return;
      }
      await delay(250);
    }
  }
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function connectToPackagedApp({
  child,
  cdpPort,
  stdout,
  stderr,
  userData,
  daemonHome,
  deadline,
}) {
  let lastError = null;
  const endpoint = `http://127.0.0.1:${cdpPort}`;

  while (Date.now() < deadline) {
    if (!isRunning(child)) {
      throw new Error(
        `Packaged app exited before opening its debugging endpoint (code ${child.exitCode}, signal ${
          child.signalCode ?? "none"
        }).\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
      );
    }

    try {
      // Electron can expose CDP before its first BrowserWindow. Playwright can
      // miss that window when it attaches before Electron creates its context.
      const response = await fetch(`${endpoint}/json/list`, {
        signal: AbortSignal.timeout(remainingTime(deadline)),
      });
      if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
      const targets = await response.json();
      if (!targets.some(({ type, url }) => type === "page" && url.startsWith("paseo://app/"))) {
        throw new Error(
          `CDP has no packaged Paseo page yet: ${JSON.stringify(targets.map(({ url }) => url))}`,
        );
      }
      return await chromium.connectOverCDP(endpoint, { timeout: remainingTime(deadline) });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(
    `Timed out connecting to the packaged app over CDP: ${lastError}.\n${formatLogs({
      stdout,
      stderr,
      userData,
      daemonHome,
    })}`,
  );
}

async function waitForPackagedAppPage(browser, deadline) {
  const urls = new Set();
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      const url = page.url();
      urls.add(url);
      if (url.startsWith("paseo://app/")) return page;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for the packaged paseo://app/ renderer. Observed URLs: ${JSON.stringify([...urls])}`,
  );
}

async function assertPackagedRendererLoaded(page, deadline) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      return root instanceof HTMLElement && root.childElementCount > 0;
    },
    undefined,
    { timeout: remainingTime(deadline) },
  );

  const bridgeKeys = await page.evaluate(() =>
    typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
      ? Object.keys(window.paseoDesktop)
      : [],
  );
  const missingBridgeKeys = REQUIRED_DESKTOP_BRIDGE_KEYS.filter((key) => !bridgeKeys.includes(key));
  if (missingBridgeKeys.length > 0) {
    throw new Error(
      `Packaged renderer is missing desktop preload bridge keys: ${missingBridgeKeys.join(", ")}. Present keys: ${bridgeKeys.join(", ") || "<none>"}`,
    );
  }
}

async function waitForRendererStartedDaemon({
  page,
  daemonHome,
  listen,
  stdout,
  stderr,
  userData,
  deadline,
}) {
  let lastStatus = null;
  let lastError = null;
  let loggedFirstOutcome = false;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const callTimeoutMs = Math.min(DAEMON_STATUS_CALL_TIMEOUT_MS, remainingTime(deadline));
    try {
      lastStatus = await raceWithTimeout(
        page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status")),
        callTimeoutMs,
        "desktop_daemon_status",
      );
      if (!loggedFirstOutcome) {
        loggedFirstOutcome = true;
        console.log(
          `Packaged desktop smoke: first desktop_daemon_status response (attempt ${attempt}): ${JSON.stringify(lastStatus)}`,
        );
      }
      if (
        lastStatus?.status === "running" &&
        lastStatus.desktopManaged === true &&
        typeof lastStatus.pid === "number" &&
        typeof lastStatus.serverId === "string" &&
        lastStatus.serverId.length > 0 &&
        lastStatus.listen === listen &&
        path.resolve(lastStatus.home) === path.resolve(daemonHome)
      ) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
      if (!loggedFirstOutcome || String(error).includes("timed out")) {
        loggedFirstOutcome = true;
        console.warn(
          `Packaged desktop smoke: desktop_daemon_status attempt ${attempt} failed: ${error}`,
        );
      }
    }
    if (Date.now() < deadline) {
      await delay(Math.min(250, remainingTime(deadline)));
    }
  }

  throw new Error(
    `Packaged renderer did not start its desktop-managed daemon. Last status: ${JSON.stringify(lastStatus)}. Last error: ${lastError}.\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
  );
}

function runShellCommand({ script, env, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const shell = getShellCommand(script);
    const child = spawn(shell.command, shell.args, {
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
    });
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseChildHandles(child);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `${label} timed out.\nStdout:\n${stdout.join("").trim() || "<empty>"}\n\nStderr:\n${
            stderr.join("").trim() || "<empty>"
          }`,
        ),
      );
    }, SMOKE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      finish(
        reject,
        new Error(
          `${label} failed (code ${code}, signal ${signal ?? "none"}).\nStdout:\n${
            stdout.join("").trim() || "<empty>"
          }\n\nStderr:\n${stderr.join("").trim() || "<empty>"}`,
        ),
      );
    });
  });
}

function getCliShimScript(cliShimPath, args) {
  const commandArgs = args.map(shellQuoteCliArg).join(" ");
  if (process.platform === "win32") {
    return `call "${cliShimPath}" ${commandArgs}`;
  }

  return `${shellQuote(cliShimPath)} ${commandArgs}`;
}

async function runCliShimCommand({ appPath, cliPath = getCliShimPath(appPath), env, args, label }) {
  assertExecutable(cliPath, "Bundled CLI shim");

  return await runShellCommand({
    script: getCliShimScript(cliPath, args),
    env,
    label,
  });
}

async function runCliShimJsonCommand({ appPath, cliPath, env, args, label }) {
  const result = await runCliShimCommand({
    appPath,
    cliPath,
    env,
    args: [...args, "--json"],
    label,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${label} produced empty JSON output`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${output}`, { cause: error });
  }
}

async function smokeCliShim({ appPath, cliPath, env }) {
  console.log("Packaged desktop smoke: running bundled CLI shim daemon status");
  const result = await runCliShimCommand({
    appPath,
    cliPath,
    env,
    args: ["daemon", "status"],
    label: "Bundled CLI shim daemon status",
  });
  assertCleanDaemonStatusOutput(`${result.stdout}\n${result.stderr}`);
}

async function smokeColdCliDaemonStart({ appPath, cliPath }) {
  const home = createTempDir("paseo-smoke-cli-daemon-home-");
  const pidPath = path.join(home, "paseo.pid");
  const port = await reserveLocalTcpPort();
  const listen = `127.0.0.1:${port}`;
  const env = createDefaultDaemonEnv({ HOME: home, USERPROFILE: home });
  configureIsolatedDaemonHome(home, listen);

  try {
    console.log("Packaged desktop smoke: cold-starting daemon through bundled CLI shim");
    await runCliShimCommand({
      appPath,
      cliPath,
      env,
      args: ["daemon", "start", "--home", home],
      label: "Bundled CLI shim cold daemon start",
    });

    const pidInfo = JSON.parse(await waitForFile(pidPath, "cold CLI daemon pid file"));
    if (!pidInfo || typeof pidInfo.pid !== "number") {
      throw new Error(`Cold CLI daemon wrote invalid pid file: ${JSON.stringify(pidInfo)}`);
    }

    if (process.platform === "darwin") {
      assertDarwinProcessDoesNotUseMainAppExecutable({
        appPath,
        pid: pidInfo.pid,
        label: "Cold CLI daemon supervisor",
      });
      const childPids = await waitForChildPids(pidInfo.pid);
      for (const childPid of childPids) {
        assertDarwinProcessDoesNotUseMainAppExecutable({
          appPath,
          pid: childPid,
          label: "Cold CLI daemon worker",
        });
      }
    }
  } finally {
    if (fs.existsSync(pidPath)) {
      await runCliShimCommand({
        appPath,
        cliPath,
        env,
        args: ["daemon", "stop", "--home", home, "--force"],
        label: "Bundled CLI shim cold daemon stop",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to stop cold CLI daemon: ${error}`);
      });
    }
    await removeTempDir(home);
  }
}

function assertCleanDaemonStatusOutput(output) {
  const failureNeedles = [
    "Get-CimInstance",
    "Get-Process :",
    "Cannot bind parameter",
    "wmic failed",
  ];
  const failure = failureNeedles.find((needle) => output.includes(needle));
  if (failure) {
    throw new Error(`Bundled CLI shim daemon status included process lookup failure: ${failure}`);
  }
}

async function smokeCliTerminal({ appPath, cliPath, env }) {
  const cwd = createTempDir("paseo-smoke-terminal-cwd-");
  const marker = `paseo-packaged-terminal-smoke-${Date.now()}`;
  const name = `packaged-smoke-${process.pid}-${Date.now()}`;
  let terminalId = null;

  try {
    console.log("Packaged desktop smoke: creating terminal through bundled CLI shim");
    const created = await runCliShimJsonCommand({
      appPath,
      cliPath,
      env,
      args: ["terminal", "create", "--cwd", cwd, "--name", name],
      label: "Bundled CLI shim terminal create",
    });
    if (!created || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`Terminal create returned unexpected payload: ${JSON.stringify(created)}`);
    }
    terminalId = created.id;

    const terminals = await runCliShimJsonCommand({
      appPath,
      cliPath,
      env,
      args: ["terminal", "ls", "--all"],
      label: "Bundled CLI shim terminal ls",
    });
    if (!Array.isArray(terminals) || !terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(`Terminal ${terminalId} was not listed after create`);
    }

    await runCliShimJsonCommand({
      appPath,
      cliPath,
      env,
      args: ["terminal", "send-keys", terminalId, terminalHookCommand(marker), "Enter"],
      label: "Bundled CLI shim terminal hook command",
    });

    for (let attempt = 1; attempt <= TERMINAL_CAPTURE_ATTEMPTS; attempt += 1) {
      const capture = await runCliShimJsonCommand({
        appPath,
        cliPath,
        env,
        args: ["terminal", "capture", terminalId, "--scrollback"],
        label: "Bundled CLI shim terminal capture",
      });
      const lines = Array.isArray(capture?.lines) ? capture.lines : [];
      if (hasTerminalOutput(lines, marker)) {
        console.log("Packaged desktop smoke: terminal hook command completed");
        return;
      }

      if (attempt < TERMINAL_CAPTURE_ATTEMPTS) {
        await delay(TERMINAL_CAPTURE_INTERVAL_MS);
      }
    }

    throw new Error(`Timed out waiting for terminal capture marker ${marker}`);
  } finally {
    if (terminalId) {
      await runCliShimJsonCommand({
        appPath,
        cliPath,
        env,
        args: ["terminal", "kill", terminalId],
        label: "Bundled CLI shim terminal kill",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to kill terminal ${terminalId}: ${error}`);
      });
    }
    await removeTempDir(cwd);
  }
}

async function stopCliDaemon({ appPath, cliPath, env }) {
  console.log("Packaged desktop smoke: stopping daemon through bundled CLI shim");
  await runCliShimCommand({
    appPath,
    cliPath,
    env,
    args: ["daemon", "stop", "--force"],
    label: "Bundled CLI shim daemon stop",
  });
}

async function openSmokeWorkspace({ appPath, cliPath, env, page, daemonHome }) {
  const projectPath = path.join(daemonHome, "sandbox-smoke-project");
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "Packaged Linux sandbox smoke\n");
  const workspace = await runCliShimJsonCommand({
    appPath,
    cliPath,
    env,
    args: [
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      projectPath,
      "--title",
      "Sandbox smoke workspace",
    ],
    label: "Create packaged smoke workspace",
  });
  // The fresh daemon had no projects at launch, so first-run setup is open over the sidebar.
  await page.evaluate(() =>
    localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "1970-01-01" })),
  );
  await page.reload();
  await page.getByRole("button", { name: "Sandbox smoke workspace", exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${workspace.workspaceId}`));
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Message agent..." }).click();
  console.log(`Packaged desktop smoke: renderer opened workspace ${workspace.workspaceId}`);
}

async function assertSandboxState({ browser, page, expectedSandbox, stdout, stderr }) {
  const diagnostics = await page.evaluate(() =>
    window.paseoDesktop.invoke("desktop_sandbox_diagnostics"),
  );
  if (diagnostics.enabled !== expectedSandbox) {
    throw new Error(
      `Unexpected sandbox decision: ${JSON.stringify(diagnostics)}; expected enabled=${expectedSandbox}`,
    );
  }
  if (!stdout.join("").includes("[desktop] app startup")) {
    throw new Error("Missing production app startup log");
  }
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const renderers = processInfo.filter((info) => info.type === "renderer");
  if (renderers.length === 0) throw new Error("No renderer process found");
  for (const renderer of renderers) {
    const status = fs.readFileSync(`/proc/${renderer.id}/status`, "utf8");
    const security = status
      .split("\n")
      .filter((line) => /^(NoNewPrivs|Seccomp|Uid|Gid):/.test(line))
      .join("; ");
    const report = `Sandbox evidence: enabled=${expectedSandbox}; ${diagnostics.reason}; renderer ${renderer.id}: ${security}`;
    console.log(report);
    stdout.push(`${report}\n`);
    if (
      expectedSandbox &&
      (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status))
    ) {
      throw new Error(`Renderer lacks OS sandbox: ${report}\n${stderr.join("")}`);
    }
  }
}

function assertLinuxDesktopIdentity(appPath) {
  if (process.platform === "linux") {
    assert.deepEqual(
      fs.readFileSync(path.join(appPath, "resources", "icon.png")),
      fs.readFileSync(path.join(__dirname, "..", "assets", "icon.png")),
      "Packaged Linux windows must have the Paseo icon at their runtime lookup path",
    );
    const metadata = JSON.parse(
      extractFile(path.join(appPath, "resources", "app.asar"), "package.json").toString(),
    );
    if (metadata.desktopName !== `${EXECUTABLE_NAME}.desktop`) {
      throw new Error(
        `Packaged Linux desktop identity ${JSON.stringify(metadata.desktopName)} does not match ${EXECUTABLE_NAME}.desktop`,
      );
    }
  }
}

async function smokePackagedDesktopApp({
  appPath,
  executablePath = getExecutablePath(appPath),
  launchArgs = [],
  expectedSandbox,
  // The Linux Nix desktop has neither electron-builder's layout nor a bundled
  // CLI: pass its separate CLI and skip the packaged identity check.
  cliPath,
  checkPackagedIdentity = true,
}) {
  assertExecutable(executablePath, "Packaged app executable");
  if (checkPackagedIdentity) assertLinuxDesktopIdentity(appPath);
  await smokeColdCliDaemonStart({ appPath, cliPath });

  const userData = createTempDir("paseo-smoke-user-data-");
  const daemonHome = createTempDir("paseo-smoke-daemon-home-");
  const daemonPort = await reserveLocalTcpPort();
  let cdpPort = await reserveLocalTcpPort();
  for (let attempt = 0; cdpPort === daemonPort && attempt < 10; attempt += 1) {
    cdpPort = await reserveLocalTcpPort();
  }
  if (cdpPort === daemonPort) {
    throw new Error("Failed to reserve distinct TCP ports for the daemon and CDP");
  }
  const listen = `127.0.0.1:${daemonPort}`;
  configureIsolatedDaemonHome(daemonHome, listen);
  const env = createIsolatedDesktopEnv({
    home: daemonHome,
    listen,
    userData,
    cdpPort,
  });

  const stdout = [];
  const stderr = [];
  const launch = getLaunchCommand(executablePath, launchArgs);
  console.log(`Packaged desktop smoke: launching ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.once("error", (error) =>
    stderr.push(`Packaged app launch error: ${error.stack ?? error}\n`),
  );
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;

  let browser = null;
  let page = null;
  let daemonStopped = false;

  const stopDaemonForCleanup = async () => {
    if (daemonStopped) {
      return;
    }

    await stopCliDaemon({ appPath, cliPath, env });
    daemonStopped = true;
  };

  try {
    browser = await connectToPackagedApp({
      child,
      cdpPort,
      stdout,
      stderr,
      userData,
      daemonHome,
      deadline,
    });
    page = await waitForPackagedAppPage(browser, deadline);
    await assertPackagedRendererLoaded(page, deadline);
    console.log("Packaged desktop smoke: real app renderer and preload bridge loaded");
    const status = await waitForRendererStartedDaemon({
      page,
      daemonHome,
      listen,
      stdout,
      stderr,
      userData,
      deadline,
    });
    console.log("Packaged desktop smoke: renderer-started desktop daemon reported running");
    await assertBuiltinPluginsStarted(listen);
    console.log("Packaged desktop smoke: every built-in plugin started");
    await smokeCliShim({ appPath, cliPath, env });
    await smokeCliTerminal({ appPath, cliPath, env });
    if (expectedSandbox !== undefined) {
      await assertSandboxState({ browser, page, expectedSandbox, stdout, stderr });
      await openSmokeWorkspace({ appPath, cliPath, env, page, daemonHome });
    }
    await writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid ${status.pid}, listen ${status.listen}; CLI shim daemon status and terminal smoke succeeded`,
    );
  } catch (error) {
    await writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome, error }).catch(
      (artifactError) => {
        console.warn(`Packaged desktop smoke: failed to write failure artifacts: ${artifactError}`);
      },
    );
    if (!daemonStopped) {
      try {
        await stopDaemonForCleanup();
      } catch {}
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (isRunning(child)) {
      terminateChild(child);
      if (!(await waitForChildExit(child))) {
        terminateChild(child, "SIGKILL");
        await waitForChildExit(child);
      }
    }
    releaseChildHandles(child);
    await removeTempDir(userData);
    await removeTempDir(daemonHome);
  }
}

module.exports = {
  smokePackagedDesktopApp,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write("Usage: node smoke-packaged-desktop-app.js --app <Paseo.app>\n");
    process.exit(2);
  }

  smokePackagedDesktopApp({ appPath }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
