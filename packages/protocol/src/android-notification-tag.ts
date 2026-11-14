import type { AgentAttentionReason } from "./agent-attention-notification.js";

const PREFIX = "paseo-agent-v1";
const MAX_TAG_LENGTH = 1024;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASONS = ["finished", "error", "permission"] as const;

export interface AndroidAgentTag {
  serverId: string;
  agentId: string;
  reason: AgentAttentionReason;
  nonce: string;
}

/** Tags are unique per alert: Android replaces already displayed rows with the same tag. */
export function encodeAndroidAgentTag(value: AndroidAgentTag): string | null {
  if (
    !value.serverId ||
    !value.agentId ||
    !REASONS.includes(value.reason) ||
    !NONCE.test(value.nonce)
  )
    return null;
  try {
    const tag = [
      PREFIX,
      encodeURIComponent(value.serverId),
      encodeURIComponent(value.agentId),
      value.reason,
      value.nonce,
    ].join(":");
    return tag.length <= MAX_TAG_LENGTH ? tag : null;
  } catch {
    return null;
  }
}

export function decodeAndroidAgentTag(tag: string): AndroidAgentTag | null {
  if (tag.length > MAX_TAG_LENGTH) return null;
  const parts = tag.split(":");
  if (parts.length !== 5 || parts[0] !== PREFIX || !NONCE.test(parts[4] ?? "")) return null;
  const reason = REASONS.find((value) => value === parts[3]);
  if (!reason) return null;
  try {
    const serverId = decodeURIComponent(parts[1] ?? "");
    const agentId = decodeURIComponent(parts[2] ?? "");
    const value = { serverId, agentId, reason, nonce: parts[4]! };
    return encodeAndroidAgentTag(value) === tag ? value : null;
  } catch {
    return null;
  }
}

/** Expo 57 encodes the OS tag and integer ID in its foreign-notification identifier. */
export function decodeExpoForeignAgentIdentifier(identifier: string): AndroidAgentTag | null {
  const match =
    /^expo-notifications:\/\/foreign_notifications\?tag=([^&]+)&id=(-?(?:0|[1-9][0-9]*))$/.exec(
      identifier,
    );
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647 || String(id) !== match[2])
    return null;
  try {
    const tag = decodeURIComponent(match[1]!);
    return encodeURIComponent(tag) === match[1] ? decodeAndroidAgentTag(tag) : null;
  } catch {
    return null;
  }
}
