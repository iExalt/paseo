import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile, readlink, stat, statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { currentBootId } from "../../pid-lock.js";

const exec = promisify(execFile);
const cgroupRoot = "/sys/fs/cgroup";
const cgroup2Magic = 0x63677270;
const unitPrefix = "paseo-run-";
const unitPattern = /^paseo-run-[0-9a-f-]{36}\.service$/;
const invocationPattern = /^(?!0{32}$)[0-9a-f]{32}$/;

export const linuxExecutionOwnerSchema = z.object({
  backend: z.literal("linux-systemd"),
  hostId: z.string().regex(/^[0-9a-f]{64}$/),
  bootId: z.string().min(1),
  cgroupNamespace: z.string().regex(/^cgroup:\[\d+\]$/),
  mountNamespace: z.string().regex(/^mnt:\[\d+\]$/),
  unit: z.string().regex(unitPattern),
  invocation: z.string().regex(invocationPattern),
  cgroup: z.string().startsWith("/"),
  cgroupRootIdentity: z.string().regex(/^\d+:\d+$/),
  cgroupIdentity: z.string().regex(/^\d+:\d+$/),
});

export type LinuxExecutionOwner = z.infer<typeof linuxExecutionOwnerSchema>;
type ExecutionOwnerState = "running" | "released" | "unknown";

type HostIdentity = Pick<
  LinuxExecutionOwner,
  "hostId" | "bootId" | "cgroupNamespace" | "mountNamespace" | "cgroupRootIdentity"
>;

async function fileIdentity(path: string): Promise<string> {
  const entry = await stat(path, { bigint: true });
  return `${entry.dev}:${entry.ino}`;
}

async function readWorkerBirth(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const [state, ...fields] = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return state === "Z" || state === "X" ? undefined : fields[18];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function getHostIdentity(): Promise<HostIdentity | undefined> {
  const bootId = currentBootId();
  if (process.platform !== "linux" || !bootId) return;
  try {
    const [machine, cgroupNamespace, mountNamespace, filesystem, cgroupRootIdentity] =
      await Promise.all([
        readFile("/etc/machine-id", "utf8"),
        readlink("/proc/self/ns/cgroup"),
        readlink("/proc/self/ns/mnt"),
        statfs(cgroupRoot),
        fileIdentity(cgroupRoot),
      ]);
    if (!/^[a-f0-9]{32}\s*$/.test(machine) || filesystem.type !== cgroup2Magic) return;
    const hostId = createHash("sha256")
      .update(`${machine.trim()}:${process.getuid?.()}`)
      .digest("hex");
    return { hostId, bootId, cgroupNamespace, mountNamespace, cgroupRootIdentity };
  } catch {
    return;
  }
}

function parseProperties(output: string): Map<string, string> {
  return new Map(
    output.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );
}

function managerEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`, LANG: "C" };
}

async function systemctl(args: string[]): Promise<string> {
  const { stdout } = await exec("systemctl", ["--user", "--no-pager", ...args], {
    timeout: 2_000,
    env: managerEnvironment(),
  });
  return stdout;
}

async function unitProperties(unit: string): Promise<Map<string, string>> {
  return parseProperties(
    await systemctl([
      "show",
      "--property=LoadState,InvocationID,ControlGroup,MainPID,ActiveState,SubState,Job",
      unit,
    ]),
  );
}

function cgroupMatchesUnit(cgroup: string, unit: string): boolean {
  const components = cgroup.split("/");
  return (
    components[0] === "" &&
    components.at(-1) === unit &&
    components.slice(1).every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function readPopulation(
  cgroup: string,
): Promise<"empty" | "populated" | "absent" | "unknown"> {
  try {
    const events = await readFile(`${cgroupRoot}${cgroup}/cgroup.events`, "utf8");
    const state = /^populated ([01])$/m.exec(events)?.[1];
    if (state === "0") return "empty";
    if (state === "1") return "populated";
    return "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

/** A transient service enrolls the worker and its descendants in a dedicated cgroup. */
export async function startLinuxExecutionOwner(
  generation: string,
  command: string,
  args: string[],
) {
  const host = await getHostIdentity();
  if (!host) throw new Error("Linux execution ownership is unavailable on this host.");
  const unit = `${unitPrefix}${generation}.service`;
  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--quiet",
      "--no-ask-password",
      "--pipe",
      `--unit=${unit}`,
      "--property=Type=exec",
      "--property=ExitType=cgroup",
      "--property=Restart=no",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=2s",
      "--",
      command,
      ...args,
    ],
    { stdio: ["pipe", "pipe", "ignore"], env: managerEnvironment() },
  );
  return {
    child,
    async attest(pid: number) {
      const deadline = performance.now() + 2_000;
      do {
        const properties = await unitProperties(unit);
        const invocation = properties.get("InvocationID") ?? "";
        const cgroup = properties.get("ControlGroup") ?? "";
        if (
          properties.get("LoadState") === "loaded" &&
          properties.get("ActiveState") === "active" &&
          properties.get("SubState") === "running" &&
          properties.get("Job") === "" &&
          invocationPattern.test(invocation) &&
          cgroupMatchesUnit(cgroup, unit) &&
          Number(properties.get("MainPID")) === pid &&
          (await readFile(`/proc/${pid}/cgroup`, "utf8")).split("\n").includes(`0::${cgroup}`) &&
          (await readPopulation(cgroup)) === "populated"
        ) {
          await access(`${cgroupRoot}${cgroup}/cgroup.kill`, constants.W_OK);
          const cgroupIdentity = await fileIdentity(`${cgroupRoot}${cgroup}`);
          const birth = await readWorkerBirth(pid);
          if (!birth) break;
          const owner: LinuxExecutionOwner = {
            backend: "linux-systemd",
            ...host,
            invocation,
            unit,
            cgroup,
            cgroupIdentity,
          };
          return {
            owner,
            async watchWorker(connected: () => boolean, onExit: () => void) {
              while (connected()) {
                // The launcher and manager can both retain stdout while a
                // tool survives the worker. Observe the worker independently.
                const alive = await readWorkerBirth(pid).then(
                  (current) => current === birth,
                  () => true,
                );
                if (!alive) {
                  onExit();
                  return;
                }
                await delay(120, undefined, { ref: false });
              }
            },
          };
        }
        await delay(25);
      } while (performance.now() < deadline);
      throw new Error("Linux execution ownership did not enroll the worker.");
    },
    async abandon() {
      // The child receives no dispatch permission before enrollment is committed.
      child.kill();
    },
  };
}

export async function inspectLinuxExecutionOwner(
  owner: LinuxExecutionOwner,
): Promise<ExecutionOwnerState> {
  const host = await getHostIdentity();
  if (!host || host.hostId !== owner.hostId) return "unknown";
  if (host.bootId !== owner.bootId) return "released";
  if (
    host.cgroupNamespace !== owner.cgroupNamespace ||
    host.mountNamespace !== owner.mountNamespace ||
    host.cgroupRootIdentity !== owner.cgroupRootIdentity ||
    !cgroupMatchesUnit(owner.cgroup, owner.unit)
  ) {
    return "unknown";
  }
  // An enrolled cgroup cannot be removed until all its descendants exit.
  // The exact original filesystem view and Restart=no make removal definitive.
  // Administrative reparenting or migration is outside this ownership boundary.
  try {
    if ((await fileIdentity(`${cgroupRoot}${owner.cgroup}`)) !== owner.cgroupIdentity)
      return "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "released" : "unknown";
  }
  const population = await readPopulation(owner.cgroup);
  if (population === "unknown") return "unknown";
  if (population === "empty" || population === "absent") return "released";
  const properties = await unitProperties(owner.unit).catch(() => undefined);
  return properties?.get("InvocationID") === owner.invocation &&
    properties.get("ControlGroup") === owner.cgroup
    ? "running"
    : "unknown";
}

export async function stopLinuxExecutionOwner(owner: LinuxExecutionOwner): Promise<void> {
  if (!cgroupMatchesUnit(owner.cgroup, owner.unit)) return;
  // Pin the kernel object before resolving the invocation. Replacing a unit
  // after attestation cannot retarget this handle to its new cgroup.
  const signal = await open(`${cgroupRoot}${owner.cgroup}/cgroup.kill`, constants.O_WRONLY).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    },
  );
  if (!signal) return;
  try {
    if ((await inspectLinuxExecutionOwner(owner)) === "running") {
      await signal.writeFile("1");
    }
  } finally {
    await signal.close();
  }
}

export async function supportsLinuxExecutionOwner(): Promise<boolean> {
  if (!(await getHostIdentity())) return false;
  try {
    const version = Number.parseInt(await systemctl(["show", "--property=Version", "--value"]), 10);
    return version >= 250;
  } catch {
    return false;
  }
}
