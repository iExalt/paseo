import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The only provider a qa:web daemon runs. Real providers stay off so a scratch daemon never
// probes the user's own CLIs or accounts.
export const QA_WEB_PROVIDER = "mock";

// Written by start; --stop refuses a home without it, so it never stops a daemon it didn't start.
export const QA_WEB_MARKER = ".qa-web";

// Long homes risk Unix socket paths over the platform limit (104 bytes on macOS).
const LONG_HOME_CHARS = 90;

const USAGE = `Usage:
  npm run qa:web -- [--home <dir>] [--port <n>] [--seed heavy] [--reuse]
  npm run qa:web -- --stop <home>`;

export function parseQaWebArgs(argv) {
  const args = { mode: "start", home: null, port: null, seed: null, reuse: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${flag} needs a value\n${USAGE}`);
      i += 1;
      return next;
    };
    if (flag === "--home") args.home = value();
    else if (flag === "--stop") {
      args.mode = "stop";
      args.home = value();
    } else if (flag === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`Invalid --port\n${USAGE}`);
      args.port = port;
    } else if (flag === "--seed") {
      const seed = value();
      if (seed !== "heavy")
        throw new Error(`Unknown seed "${seed}"; only "heavy" exists\n${USAGE}`);
      args.seed = seed;
    } else if (flag === "--reuse") args.reuse = true;
    else throw new Error(`Unknown option ${flag}\n${USAGE}`);
  }
  return args;
}

/**
 * The scratch daemon's whole configuration. Everything lives here rather than in environment
 * overrides, which `paseo daemon start` drops. `providerIds` is every registered provider, so a
 * provider added later is disabled too.
 */
export function buildQaWebConfig({ port, providerIds }) {
  const providers = Object.fromEntries(
    providerIds.map((id) => [id, { enabled: id === QA_WEB_PROVIDER }]),
  );
  providers[QA_WEB_PROVIDER] = { enabled: true };
  return {
    version: 1,
    daemon: {
      listen: `127.0.0.1:${port}`,
      // Explicit: a config without this field keeps the old relay-on default.
      relay: { enabled: false },
      // Usage sources read the user's provider accounts.
      usage: { enabled: false },
    },
    pluginsEnabled: false,
    agents: { providers },
    features: {
      webUi: { enabled: true },
      dictation: { enabled: false },
      voiceMode: { enabled: false },
    },
  };
}

/**
 * Environment for every child process. Inherited `PASEO_*` keys are dropped, since an agent
 * running inside Paseo carries its own daemon's home and host; the mock provider needs
 * development mode, which a managed start keeps.
 */
export function qaWebEnv(env, home) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  return { ...clean, PASEO_HOME: home, PASEO_NODE_ENV: "development" };
}

// Symlinks resolve for paths that exist, so a link to ~/.paseo is still recognised.
function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Returns warnings; throws when the home could be someone's real daemon home. */
export function checkQaWebHome({ home, env, homeDir = os.homedir(), hasConfig, reuse }) {
  const resolved = realPath(home);
  const protectedHomes = [path.join(homeDir, ".paseo"), env.PASEO_HOME]
    .filter(Boolean)
    .map(realPath);
  if (protectedHomes.includes(resolved)) {
    throw new Error(`Refusing to use ${resolved}: it is a real daemon home`);
  }
  if (hasConfig && !reuse) {
    throw new Error(`${resolved} already has a config.json; pass --reuse or pick another --home`);
  }
  return resolved.length > LONG_HOME_CHARS
    ? [`${resolved} is ${resolved.length} characters; a Unix socket under it may exceed the limit`]
    : [];
}

export function checkQaWebStopHome({ home, hasMarker }) {
  if (!hasMarker) {
    throw new Error(`Refusing to stop ${home}: qa:web did not start it (no ${QA_WEB_MARKER})`);
  }
}

/**
 * Provider IDs registered by built-in plugins. A plugin named `<id>-provider` registers the
 * provider `<id>`; qa-web.test.mjs checks that convention against the plugin sources.
 */
export function builtinPluginProviderIds(builtinPlugins) {
  return builtinPlugins
    .filter((id) => id.endsWith("-provider"))
    .map((id) => id.slice(0, -"-provider".length));
}
