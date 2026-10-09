import { spawn } from "node:child_process";
import type { DesktopInstallation } from "./nix-managed-install.js";

export const NIX_UPDATE_COMMANDS = ["check", "status", "stage", "activate", "rollback"] as const;
export type NixUpdateCommand = (typeof NIX_UPDATE_COMMANDS)[number];

export interface NixReleaseSummary {
  releaseTag: string;
  packageVersion: string;
  releaseSequence: number;
  outputPath: string;
}

export interface NixUpdateResult {
  ok: true;
  action: NixUpdateCommand;
  latest?: NixReleaseSummary;
  active: NixReleaseSummary | null;
  staged?: NixReleaseSummary | null;
  highWaterSequence: number;
  canStage?: boolean;
  message?: string;
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
  if (!Number.isSafeInteger(value.highWaterSequence) || (value.highWaterSequence as number) < 0) {
    fail("The managed Nix updater returned an invalid release sequence.");
  }
  const validateRelease = (release: unknown): release is NixReleaseSummary =>
    release === null ||
    (isObject(release) &&
      typeof release.releaseTag === "string" &&
      typeof release.packageVersion === "string" &&
      Number.isSafeInteger(release.releaseSequence) &&
      typeof release.outputPath === "string" &&
      /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/.test(release.outputPath));
  if (!validateRelease(value.active))
    fail("The managed Nix updater returned an invalid active release.");
  if ("latest" in value && !validateRelease(value.latest)) {
    fail("The managed Nix updater returned an invalid candidate release.");
  }
  if ("staged" in value && !validateRelease(value.staged)) {
    fail("The managed Nix updater returned an invalid staged release.");
  }
  if (typeof value.message === "string") value.message = sanitizeDiagnostic(value.message);
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
