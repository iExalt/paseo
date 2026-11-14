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

const REASONS: readonly TrackedNotificationReason[] = ["finished", "error", "permission"];

/**
 * Group id for desktop notifications: the key plus the reason. macOS history returns only
 * ids and group ids, so a restarted app reads the reason back from here.
 */
export function agentNotificationGroupId(key: string, reason: TrackedNotificationReason): string {
  return `${key}:${reason}`;
}

/** Reads a delivered desktop notification back: the thread from its id, the reason from its group. */
export function parseDeliveredAgentNotification(delivered: {
  id: string;
  groupId: string;
}): (AgentNotificationIdentity & { reason: TrackedNotificationReason }) | null {
  const identity = parseAgentNotificationKey(delivered.id);
  if (!identity) return null;
  const prefix = `${delivered.id}:`;
  const reason = delivered.groupId.startsWith(prefix)
    ? delivered.groupId.slice(prefix.length)
    : null;
  return { ...identity, reason: REASONS.find((known) => known === reason) ?? "unknown" };
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
