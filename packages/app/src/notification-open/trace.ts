import { agentLog } from "@/utils/agent-log";

let current: { serverId: string; agentId: string; startedAt: number; stages: Set<string> } | null =
  null;

export function beginNotificationOpenTrace(serverId: string, agentId: string): void {
  current = { serverId, agentId, startedAt: performance.now(), stages: new Set() };
  recordNotificationOpenStage(serverId, agentId, "tap");
}

export function recordNotificationOpenStage(
  serverId: string,
  agentId: string,
  stage: string,
): void {
  if (!current || current.serverId !== serverId || current.agentId !== agentId) return;
  if (current.stages.has(stage)) return;
  current.stages.add(stage);
  agentLog("push", "open", {
    serverId,
    agentId,
    stage,
    elapsedMs: Math.round(performance.now() - current.startedAt),
  });
}
