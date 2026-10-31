import path from "node:path";

/**
 * Whether Electron's chrome-sandbox helper next to `electronPath` is setuid root. Only Linux has
 * the helper, and only the Linux launch reads this, so macOS keeps its sandbox.
 */
export function hasSetuidSandbox(stat) {
  return stat !== null && stat.uid === 0 && (stat.mode & 0o4000) !== 0;
}

// Written by start; --stop refuses a home without it.
export const SANDBOX_MARKER = ".desktop-sandbox";

const USAGE = `Usage:
  npm run desktop:sandbox -- [--seed heavy] [--metro <url>] [--allow-window]
  npm run desktop:sandbox -- --stop <home>`;

export function parseSandboxArgs(argv) {
  const args = { mode: "start", home: null, seed: null, metro: null, allowWindow: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} needs a value\n${USAGE}`);
      }
      i += 1;
      return next;
    };
    if (flag === "--stop") {
      args.mode = "stop";
      args.home = value();
    } else if (flag === "--seed") {
      args.seed = value();
    } else if (flag === "--metro") {
      args.metro = value();
    } else if (flag === "--allow-window") {
      args.allowWindow = true;
    } else {
      throw new Error(`Unknown option ${flag}\n${USAGE}`);
    }
  }
  return args;
}

/**
 * Environment for the sandboxed Electron. Inherited `PASEO_*` keys are dropped, so the app can
 * only find the scratch daemon home, and debugging listens on loopback only.
 */
export function sandboxElectronEnv(env, { home, rendererUrl, cdpPort }) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  return {
    ...clean,
    PASEO_HOME: home,
    EXPO_DEV_URL: rendererUrl,
    // Short, so Chromium's socket paths under it stay within the platform limit.
    PASEO_ELECTRON_USER_DATA_DIR: path.join(home, "ud"),
    PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  };
}

/** The command that runs Electron without opening a window on the user's screen. */
export function sandboxLaunchCommand({
  platform,
  electronPath,
  appDir,
  allowWindow,
  setuidSandbox = true,
}) {
  if (platform === "linux") {
    // Without a setuid-root chrome-sandbox helper, Electron aborts unless the sandbox is off.
    const sandboxFlags = setuidSandbox ? [] : ["--no-sandbox"];
    return { command: "xvfb-run", args: ["-a", electronPath, ...sandboxFlags, appDir] };
  }
  if (!allowWindow) {
    throw new Error(
      `desktop:sandbox opens a real window on ${platform}. Run it on a Linux host with Xvfb, or pass --allow-window.`,
    );
  }
  return { command: electronPath, args: [appDir] };
}

/** Throws unless the desktop app adopted the sandbox's own daemon. */
export function checkSandboxDaemon(status, qa) {
  const home = path.resolve(String(status?.home ?? ""));
  if (home !== path.resolve(qa.home) || status?.serverId !== qa.serverId) {
    throw new Error(
      `The desktop app attached to ${status?.home || "no home"} (${status?.serverId || "no server"}), not the sandbox daemon ${qa.home} (${qa.serverId})`,
    );
  }
}

export function checkSandboxStopHome({ home, hasMarker }) {
  if (!hasMarker) {
    throw new Error(
      `Refusing to stop ${home}: desktop:sandbox did not start it (no ${SANDBOX_MARKER})`,
    );
  }
}
