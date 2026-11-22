import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-file.js";
import { stageWindowsKeeper } from "./windows-keeper-binary.js";

export const windowsExecutionOwnerSchema = z.object({
  backend: z.literal("windows-job"),
  generation: z.uuid(),
  hostId: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: z.string().min(1),
});
export type WindowsExecutionOwner = z.infer<typeof windowsExecutionOwnerSchema>;

const exec = promisify(execFile);
export const windowsOwnerPipePrefix = String.raw`\\.\pipe\paseo-owner-`;
let identity: Promise<string | undefined> | undefined;
let daemonBirth: string | undefined;

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
  const pipe = windowsOwnerPipePrefix + generation;
  const argv = [command, ...args, "--paseo-owner-pipe", pipe].map(windowsArgument).join(" ");
  const executable = await stageWindowsKeeper();
  const env = {
    SystemRoot: root,
    WINDIR: root,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: join(root, "System32"),
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (!daemonBirth) {
    // Query while this daemon is live, before handing its identity to the keeper.
    const { stdout } = await exec(executable, ["--process-birth", String(process.pid)], {
      env,
      timeout: 3_000,
      windowsHide: true,
    });
    const birth = stdout.trim();
    if (!/^[0-9]+$/.test(birth)) throw new Error("Unable to identify the Paseo daemon.");
    daemonBirth = birth;
  }
  const child = spawn(
    executable,
    [command, argv, job, receipt, generation, pipe, String(process.pid), daemonBirth],
    { detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env },
  );
  child.unref();
  return {
    child,
    async attest(_pid: number) {
      const owner: WindowsExecutionOwner = { backend: "windows-job", generation, hostId, receipt };
      return {
        owner,
        async watchWorker(connected: () => boolean, onExit: () => void) {
          // A blocked relay can delay stdout EOF while a descendant survives.
          // Only the keeper's retained process handle can confirm worker exit.
          while (connected()) {
            const exited = await readFile(`${receipt}.writer-exited`, "utf8").catch(
              () => undefined,
            );
            if (exited === generation) {
              onExit();
              return;
            }
            await delay(100, undefined, { ref: false });
          }
        },
      };
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
  await rm(`${owner.receipt}.writer-exited`, { force: true });
}
