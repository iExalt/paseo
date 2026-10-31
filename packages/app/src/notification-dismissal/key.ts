import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";

const KEY_PREFIX = "paseo-agent";

export type TrackedNotificationReason = AgentAttentionReason | "unknown";

export interface AgentNotificationIdentity {
  serverId: string;
  agentId: string;
}

/** One OS notification slot per thread; a newer notification for the thread replaces it. */
export function agentNotificationKey(identity: AgentNotificationIdentity): string {
  return `${KEY_PREFIX}:${encodeURIComponent(identity.serverId)}:${encodeURIComponent(identity.agentId)}`;
}

export function parseAgentNotificationKey(key: string): AgentNotificationIdentity | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  try {
    const serverId = decodeURIComponent(parts[1] ?? "");
    const agentId = decodeURIComponent(parts[2] ?? "");
    return serverId && agentId ? { serverId, agentId } : null;
  } catch {
    return null;
  }
}

/**
 * Reads the agent-attention fields of a notification payload. Terminal, host and test
 * notifications carry no agent reason and are never tracked.
 */
export function readAgentNotificationData(
  data: unknown,
): (AgentNotificationIdentity & { reason: AgentAttentionReason }) | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const serverId: unknown = Reflect.get(data, "serverId");
  const agentId: unknown = Reflect.get(data, "agentId");
  const reason: unknown = Reflect.get(data, "reason");
  if (typeof serverId !== "string" || !serverId || typeof agentId !== "string" || !agentId) {
    return null;
  }
  if (reason !== "finished" && reason !== "error" && reason !== "permission") return null;
  return { serverId, agentId, reason };
}
