import { forkReleaseTag, parseForkVersion } from "@getpaseo/protocol/fork-version";
import { spawn } from "node:child_process";
import type { DesktopInstallation } from "./nix-managed-install.js";

export const NIX_UPDATE_COMMANDS = ["check", "status", "stage", "activate", "rollback"] as const;
export type NixUpdateCommand = (typeof NIX_UPDATE_COMMANDS)[number];

export interface NixReleaseSummary {
  releaseTag: string;
  version: string;
  outputPath: string;
}

export interface NixUpdateResult {
  ok: true;
  action: NixUpdateCommand;
  latest?: NixReleaseSummary;
  active: NixReleaseSummary | null;
  staged?: NixReleaseSummary | null;
  highWaterVersion: string | null;
  canStage?: boolean;
  message?: string;
  latestError?: string;
  running: { version: string; outputPath: string };
}

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function fail(message: string): never {
  throw new Error(message);
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/\/nix\/store\/[a-z0-9]{32}-[^/\s]+/g, "Nix store output").slice(0, 4_096);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeLatestError(value: Record<string, unknown>): void {
  if (!("latestError" in value)) return;
  if (typeof value.latestError !== "string" || !value.latestError) {
    fail("The managed Nix updater returned an invalid release lookup error.");
  }
  value.latestError = sanitizeDiagnostic(value.latestError);
}

function parseResult(stdout: Buffer, command: NixUpdateCommand): Omit<NixUpdateResult, "running"> {
  const text = stdout.toString("utf8").trim();
  if (!text || text.includes("\n")) fail("The managed Nix updater returned invalid JSON output.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("The managed Nix updater returned invalid JSON output.");
  }
  if (!isObject(value) || value.ok !== true || value.action !== command) {
    if (
      isObject(value) &&
      value.ok === false &&
      typeof value.error === "string" &&
      value.error.length > 0
    ) {
      fail(sanitizeDiagnostic(value.error));
    }
    fail("The managed Nix updater returned an unexpected result.");
  }
  const isVersion = (version: unknown): version is string => {
    try {
      parseForkVersion(version);
      return true;
    } catch {
      return false;
    }
  };
  if (value.highWaterVersion !== null && !isVersion(value.highWaterVersion)) {
    fail("The managed Nix updater returned an invalid fork high-water version.");
  }
  const validateRelease = (release: unknown): release is NixReleaseSummary =>
    release === null ||
    (isObject(release) &&
      isVersion(release.version) &&
      release.releaseTag === forkReleaseTag(release.version) &&
      typeof release.outputPath === "string" &&
      /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/.test(release.outputPath) &&
      release.outputPath.endsWith(`-paseo-desktop-${release.version}`));
  if (!validateRelease(value.active))
    fail("The managed Nix updater returned an invalid active release.");
  if ("latest" in value && !validateRelease(value.latest)) {
    fail("The managed Nix updater returned an invalid candidate release.");
  }
  if ("staged" in value && !validateRelease(value.staged)) {
    fail("The managed Nix updater returned an invalid staged release.");
  }
  if (typeof value.message === "string") value.message = sanitizeDiagnostic(value.message);
  sanitizeLatestError(value);
  return value as unknown as Omit<NixUpdateResult, "running">;
}

export function createNixUpdaterCommandRunner(input: {
  installation: DesktopInstallation;
  runningVersion: string;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}): (command: NixUpdateCommand) => Promise<NixUpdateResult> {
  const spawnProcess = input.spawnProcess ?? spawn;
  return async (command) => {
    if (!NIX_UPDATE_COMMANDS.includes(command)) fail("Unsupported managed Nix updater command.");
    const installation = input.installation;
    if (installation.mode !== "nix") {
      fail(
        installation.mode === "nix-invalid"
          ? `The Nix-managed desktop marker is invalid: ${installation.error}`
          : "This desktop installation is not managed by Nix.",
      );
    }
    const child = spawnProcess(installation.cliPath, [command, "--json"], {
      cwd: installation.outputPath,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let abortReason: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    return await new Promise<NixUpdateResult>((resolve, reject) => {
      const timeout = setTimeout(
        () => terminate("Managed Nix updater exceeded its time limit."),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const clearTimers = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
      };
      const terminate = (reason: string) => {
        if (abortReason) return;
        abortReason = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          terminate("Managed Nix updater exceeded its output limit.");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) {
          terminate("Managed Nix updater exceeded its diagnostic output limit.");
          return;
        }
        stderr.push(chunk);
      });
      child.once("error", (error) => {
        clearTimers();
        reject(new Error(`Could not start the managed Nix updater: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimers();
        if (abortReason) {
          reject(new Error(abortReason));
          return;
        }
        let result: Omit<NixUpdateResult, "running">;
        try {
          result = parseResult(Buffer.concat(stdout), command);
        } catch (error) {
          const details = sanitizeDiagnostic(Buffer.concat(stderr).toString("utf8").trim());
          reject(
            new Error(
              `${error instanceof Error ? error.message : "Managed Nix updater failed."}${details ? ` ${details}` : ""}`,
            ),
          );
          return;
        }
        if (code !== 0) {
          const details = sanitizeDiagnostic(Buffer.concat(stderr).toString("utf8").trim());
          reject(new Error(details || "The managed Nix updater failed."));
          return;
        }
        resolve({
          ...result,
          running: { version: input.runningVersion, outputPath: installation.outputPath },
        });
      });
    });
  };
}

export interface ConfirmedDaemonInstance {
  pid: number;
  startedAt: string;
}

export function nixReleaseExecutable(outputPath: string, platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? `${outputPath}/Applications/Paseo.app/Contents/MacOS/Paseo`
    : `${outputPath}/bin/paseo-desktop`;
}

export function parseConfirmedDaemonInstance(
  args: Record<string, unknown> | undefined,
): ConfirmedDaemonInstance | null {
  return typeof args?.pid === "number" && typeof args.startedAt === "string"
    ? { pid: args.pid, startedAt: args.startedAt }
    : null;
}

export type NixRelaunch =
  | { kind: "exec"; execPath: string }
  | { kind: "handoff"; command: string; args: string[] };

// On macOS the running app's updater takes over: once this process exits it
// replaces /Applications/Paseo.app, which nothing runs from by then, and opens it.
// Launching by bundle id could pick a stale registered store bundle.
export function nixRelaunch(input: {
  activeOutputPath: string;
  cliPath: string;
  pid: number;
  platform: NodeJS.Platform;
}): NixRelaunch {
  return input.platform === "darwin"
    ? {
        kind: "handoff",
        command: input.cliPath,
        args: ["install-app", "--after-exit", String(input.pid)],
      }
    : { kind: "exec", execPath: nixReleaseExecutable(input.activeOutputPath, input.platform) };
}

// Restart into the active profile generation. The daemon goes first because it keeps
// running after the app quits, and only the instance the user confirmed may be stopped.
export async function restartIntoActiveNixRelease(input: {
  runNixUpdate: (command: NixUpdateCommand) => Promise<NixUpdateResult>;
  confirmedDaemon: ConfirmedDaemonInstance | null;
  stopDaemon: (confirmed: ConfirmedDaemonInstance) => Promise<unknown>;
  relaunch: (target: NixRelaunch) => void;
  cliPath: string;
  pid: number;
  platform: NodeJS.Platform;
}): Promise<void> {
  const { active } = await input.runNixUpdate("status");
  if (!active) fail("There is no active Nix release to restart into.");
  if (input.confirmedDaemon) await input.stopDaemon(input.confirmedDaemon);
  input.relaunch(
    nixRelaunch({
      activeOutputPath: active.outputPath,
      cliPath: input.cliPath,
      pid: input.pid,
      platform: input.platform,
    }),
  );
}
