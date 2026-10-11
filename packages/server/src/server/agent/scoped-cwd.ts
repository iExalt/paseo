import { expandUserPath, resolvePathFromBase } from "../path-utils.js";
import type { VoiceCallerContext } from "../voice-types.js";

export function resolveScopedAgentCwd(params: {
  requestedCwd?: string;
  callerAgent: { cwd: string } | null;
  callerContext?: VoiceCallerContext | null;
  required?: boolean;
}): string {
  if (params.callerAgent) {
    const lockedCwd = params.callerContext?.lockedCwd?.trim();
    if (lockedCwd) return expandUserPath(lockedCwd);

    const requestedCwd = params.requestedCwd?.trim();
    if (!requestedCwd || params.callerContext?.allowCustomCwd === false) {
      return params.callerAgent.cwd;
    }
    return resolvePathFromBase(params.callerAgent.cwd, requestedCwd);
  }

  const cwd = params.requestedCwd?.trim();
  if (!cwd) {
    if (params.required) throw new Error("cwd is required");
    throw new Error("cwd is required outside an agent-scoped session");
  }
  return expandUserPath(cwd);
}
