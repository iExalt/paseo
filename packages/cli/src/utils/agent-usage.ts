import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export function contextWindowPercent(usage: AgentSnapshotPayload["lastUsage"]): number | null {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (
    used == null ||
    max == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(max) ||
    used < 0 ||
    max <= 0
  )
    return null;
  return Math.round(Math.min(100, (used / max) * 100));
}
