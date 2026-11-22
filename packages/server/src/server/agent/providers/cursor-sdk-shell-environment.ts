import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

const identityKeys = [
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_WORKSPACE_ID",
  "PASEO_HOME",
  "PASEO_HOST",
  "PASEO_CLI",
];
const sdkCredential = "CURSOR_API_KEY";
const restoreKey = "__CURSOR_SANDBOX_TEMP_RESTORE";
const ownedEnvKey = "__CURSOR_SANDBOX_OWNED_ENV";
const managedKeys = [...identityKeys, sdkCredential];
const controlledKeys = new Set([...managedKeys, restoreKey, ownedEnvKey]);
const unsupportedKeys = new Set([
  sdkCredential,
  "ARGC",
  "BASHOPTS",
  "BASHPID",
  "EUID",
  "GROUPS",
  "HISTCMD",
  "LINENO",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "PPID",
  "PWD",
  "RANDOM",
  "SECONDS",
  "SHELLOPTS",
  "SHLVL",
  "SRANDOM",
  "UID",
  "_",
  "status",
  "pipestatus",
  "signals",
  "path",
]);
const shellEnvironment = new AsyncLocalStorage<{
  restore: string;
  owned: ReadonlySet<string>;
}>();

async function findShellFile(shell: string): Promise<string | undefined> {
  if (shell.includes("/")) return shell;
  const search = [process.cwd(), ...(process.env.PATH ?? "").split(delimiter)];
  for (const dir of search) {
    const file = join(dir, shell);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) return file;
  }
  return undefined;
}

export function canRequestCursorShellEnvironment(): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false;
  const hint = process.env.SHELL ?? "";
  return hint.includes("zsh") || hint.includes("bash") || !/pwsh|powershell/.test(hint);
}

async function hasCursorShellEnvironment(): Promise<boolean> {
  if (!canRequestCursorShellEnvironment()) return false;
  const hint = process.env.SHELL ?? "";
  // Match the pinned SDK's POSIX terminal selection before checking executability.
  const shell =
    hint.includes("zsh") || hint.includes("bash")
      ? await findShellFile(hint)
      : ((await findShellFile("zsh")) ?? (await findShellFile("bash")));
  if (!shell) return false;
  return access(shell, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function quoteShellValue(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function prepareCursorShellEnvironment(
  env: Readonly<Record<string, string>> = {},
  paseoHome?: string,
) {
  const settings = paseoHome === undefined ? env : { ...env, PASEO_HOME: paseoHome };
  const entries = Object.entries(settings);
  const invalid = entries.find(
    ([key, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      value.includes("\0") ||
      unsupportedKeys.has(key) ||
      /^(BASH|ZSH)(_|$)|^__CURSOR_SANDBOX_/.test(key),
  );
  if (invalid) {
    throw new Error(
      `Cursor SDK cannot apply shell environment variable ${JSON.stringify(invalid[0])}.`,
    );
  }
  const requested = entries.some(([key]) => key === "PASEO_CLI" || !controlledKeys.has(key));
  if (!(await hasCursorShellEnvironment())) {
    if (requested) {
      throw new Error(
        "Cursor SDK cannot apply agent-local shell environment without Bash or Zsh on a supported host.",
      );
    }
    return undefined;
  }
  try {
    await (supportCheck ??= verifySpawnEnvironment());
  } catch (error) {
    if (requested) {
      throw new Error(
        "Cursor SDK cannot apply agent-local shell environment in this Node runtime.",
        { cause: error },
      );
    }
    return undefined;
  }
  return createCursorShellEnvironment(settings);
}

function createCursorShellEnvironment(settings: Readonly<Record<string, string>>) {
  const entries = Object.entries(settings);
  const owned = new Set([...managedKeys, ...entries.map(([key]) => key)]);
  const restore = [
    ...managedKeys
      .filter((key) => !Object.hasOwn(settings, key))
      .map((key) => `builtin unset ${key}`),
    ...entries.map(
      ([key, value]) => `builtin export ${key}=${quoteShellValue(value)} || builtin exit 126`,
    ),
  ].join("; ");
  return { restore, owned };
}

interface SpawnEvent {
  options?: { detached?: boolean; args?: string[]; envPairs?: string[] };
}

function applyCursorShellEnvironment(message: unknown): void {
  const context = shellEnvironment.getStore();
  const { options } = (message ?? {}) as SpawnEvent;
  if (
    !context ||
    !options?.detached ||
    !Array.isArray(options.args) ||
    !Array.isArray(options.envPairs)
  )
    return;
  const args = options.args;
  const commandIndex = args.indexOf("-c");
  const command = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
  const capturesLoginState =
    args.some((arg) => /\bdump_(?:bash|zsh)_state(?:_light)?\b/.test(arg)) && command === undefined;
  // SDK 1.4.2 evaluates this slot after replaying the login shell's state.
  // Match the native command wrapper without changing argv or the #558 ownership trace.
  const restoresLoginState = command?.includes(`\${${restoreKey}:-}`);
  if (!capturesLoginState && !restoresLoginState) return;
  const retained = options.envPairs.filter((entry) => {
    const key = entry.slice(0, entry.indexOf("="));
    return !controlledKeys.has(key);
  });
  options.envPairs = [
    ...retained,
    ...(restoresLoginState ? [`${restoreKey}=${context.restore}`] : []),
    `${ownedEnvKey}=${[...context.owned].join(" ")}`,
  ];
}

channel("tracing:child_process.spawn:start").subscribe(applyCursorShellEnvironment);

export function withCursorShellEnvironment<T>(
  environment: ReturnType<typeof createCursorShellEnvironment> | undefined,
  start: () => T,
): T {
  return environment ? shellEnvironment.run(environment, start) : start();
}

let supportCheck: Promise<void> | undefined;

async function verifySpawnEnvironment(): Promise<void> {
  const environment = createCursorShellEnvironment({ PASEO_CURSOR_ENV_PROBE: "enabled" });
  const child = withCursorShellEnvironment(environment, () =>
    spawn("/bin/sh", ["-c", `test -n "\${${restoreKey}:-}"`], {
      detached: true,
      env: {},
      stdio: "ignore",
    }),
  );
  const [code] = await once(child, "exit", { signal: AbortSignal.timeout(2000) });
  if (code !== 0) {
    throw new Error("Cursor SDK shell environment is unavailable in this Node runtime.");
  }
}
