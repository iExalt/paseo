import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-file.js";
import { windowsJobSource } from "./windows-job-script.js";

export const windowsExecutionOwnerSchema = z.object({
  backend: z.literal("windows-job"),
  generation: z.uuid(),
  hostId: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: z.string().min(1),
});
export type WindowsExecutionOwner = z.infer<typeof windowsExecutionOwnerSchema>;

const exec = promisify(execFile);
let identity: Promise<string | undefined> | undefined;

async function getHostIdentity(): Promise<string | undefined> {
  const root = process.env.SystemRoot;
  if (process.platform !== "win32" || !root) return;
  try {
    const { stdout } = await exec(
      join(root, "System32", "reg.exe"),
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { timeout: 2_000, windowsHide: true },
    );
    const guid = /\bMachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i.exec(stdout)?.[1];
    if (guid) return createHash("sha256").update(guid.toLowerCase()).digest("hex");
  } catch {
    return;
  }
}

function powershellString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function windowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&") + '"';
}

export async function startWindowsExecutionOwner(
  command: string,
  args: string[],
  home: string,
  generation: string,
) {
  const root = process.env.SystemRoot;
  const hostId = await (identity ??= getHostIdentity());
  if (!root || !hostId) throw new Error("Windows execution ownership is unavailable.");
  const directory = join(home, "execution-owner");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = join(directory, `${generation}.released`);
  const job = `Local\\PaseoOwner-${generation}`;
  const argv = [command, ...args].map(windowsArgument).join(" ");
  const invoke = [command, argv, job, receipt, generation].map(powershellString).join(", ");
  const script = `\n$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${windowsJobSource}\n'@\n[PaseoJobOwner]::Run(${invoke})\n`;
  const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        SystemRoot: root,
        WINDIR: root,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: join(root, "System32"),
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  );
  child.unref();
  return {
    child,
    async attest(_pid: number): Promise<WindowsExecutionOwner> {
      return { backend: "windows-job", generation, hostId, receipt };
    },
    async abandon() {
      child.kill();
    },
  };
}

export async function inspectWindowsExecutionOwner(owner: WindowsExecutionOwner) {
  if ((await (identity ??= getHostIdentity())) !== owner.hostId) return "unknown";
  try {
    return (await readFile(owner.receipt, "utf8")) === owner.generation ? "released" : "unknown";
  } catch (error) {
    // No receipt means admission remains blocked even if the keeper died and
    // Windows has already terminated all the processes in its Job.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "running" : "unknown";
  }
}

export async function stopWindowsExecutionOwner(owner: WindowsExecutionOwner): Promise<void> {
  if ((await inspectWindowsExecutionOwner(owner)) !== "running") return;
  await writeFileAtomic(`${owner.receipt}.stop`, owner.generation);
}

export async function forgetWindowsExecutionOwner(owner: WindowsExecutionOwner): Promise<void> {
  if ((await inspectWindowsExecutionOwner(owner)) !== "released") return;
  await rm(owner.receipt);
  await rm(`${owner.receipt}.stop`, { force: true });
}
