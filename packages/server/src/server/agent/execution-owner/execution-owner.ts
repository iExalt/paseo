import { z } from "zod";
import {
  inspectLinuxExecutionOwner,
  linuxExecutionOwnerSchema,
  supportsLinuxExecutionOwner,
  stopLinuxExecutionOwner,
} from "./linux-systemd-owner.js";
import {
  forgetWindowsExecutionOwner,
  inspectWindowsExecutionOwner,
  stopWindowsExecutionOwner,
  windowsExecutionOwnerSchema,
} from "./windows-job-owner.js";

export const executionOwnerSchema = z.discriminatedUnion("backend", [
  linuxExecutionOwnerSchema,
  windowsExecutionOwnerSchema,
]);
export type ExecutionOwner = z.infer<typeof executionOwnerSchema>;
export type ExecutionOwnerState = "running" | "released" | "unknown";

export function inspectExecutionOwner(owner: ExecutionOwner): Promise<ExecutionOwnerState> {
  if (owner.backend === "windows-job") return inspectWindowsExecutionOwner(owner);
  return inspectLinuxExecutionOwner(owner);
}

export async function forgetReleasedExecutionOwner(owner: ExecutionOwner): Promise<void> {
  if (owner.backend === "windows-job") return forgetWindowsExecutionOwner(owner);
}

export function requestExecutionOwnerStop(owner: ExecutionOwner): Promise<void> {
  if (owner.backend === "windows-job") return stopWindowsExecutionOwner(owner);
  return stopLinuxExecutionOwner(owner);
}

export async function supportsExecutionOwner(): Promise<boolean> {
  return process.platform === "win32" || (await supportsLinuxExecutionOwner());
}
