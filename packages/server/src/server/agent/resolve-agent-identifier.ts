import {
  findAgentsByProviderSessionId,
  formatAmbiguousProviderSessionIdError,
  type ProviderSessionIdSource,
} from "@getpaseo/protocol/agent-provider-session-id";

export type AgentIdentifierResolution =
  | { ok: true; agentId: string }
  | { ok: false; notFound: boolean; error: string };

export interface ResolvableLiveAgent extends ProviderSessionIdSource {
  id: string;
  internal?: boolean;
  config?: { title?: string | null } | null;
}

export interface ResolvableStoredAgent extends ProviderSessionIdSource {
  id: string;
  title?: string | null;
  internal?: boolean;
}

export interface AgentIdentifierSources {
  /** Every live agent, internal ones included. */
  live: ReadonlyArray<ResolvableLiveAgent>;
  /** Every stored record, internal and archived ones included. */
  stored: ReadonlyArray<ResolvableStoredAgent>;
  /** Whether a recently archived internal agent with this exact ID is still readable. */
  isRetiredInternalAgent: (agentId: string) => boolean;
}

/**
 * Resolve what a caller typed as an agent target to a Paseo agent ID, in this order:
 *
 * 1. Any live agent or retired internal agent by exact ID. Internal agents are addressable this way
 *    and no other: the caller that created one holds its ID, and no listing includes it.
 * 2. A visible agent by exact Paseo ID.
 * 3. A visible agent by exact provider session ID, the ID "Copy session ID" copies. More than one
 *    match is an error that lists them all.
 * 4. A unique Paseo ID prefix, then a unique stored title.
 */
export function resolveAgentIdentifierFrom(
  identifier: string,
  sources: AgentIdentifierSources,
): AgentIdentifierResolution {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, notFound: false, error: "Agent identifier cannot be empty" };
  }

  if (
    sources.live.some((agent) => agent.id === trimmed) ||
    sources.isRetiredInternalAgent(trimmed)
  ) {
    return { ok: true, agentId: trimmed };
  }

  const storedRecords = sources.stored.filter((record) => !record.internal);
  const liveAgents = sources.live.filter((agent) => !agent.internal);
  const knownIds = new Set<string>();
  for (const record of storedRecords) {
    knownIds.add(record.id);
  }
  for (const agent of liveAgents) {
    knownIds.add(agent.id);
  }

  if (knownIds.has(trimmed)) {
    return { ok: true, agentId: trimmed };
  }

  const nativeMatch = resolveProviderSessionId(trimmed, sources);
  if (nativeMatch) {
    return nativeMatch;
  }

  const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
  if (prefixMatches.length === 1) {
    return { ok: true, agentId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      notFound: false,
      error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
        .slice(0, 5)
        .map((id) => id.slice(0, 8))
        .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
    };
  }

  const titleMatches = storedRecords.filter((record) => record.title === trimmed);
  if (titleMatches.length === 1) {
    return { ok: true, agentId: titleMatches[0].id };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      notFound: false,
      error: `Agent title "${trimmed}" is ambiguous (${titleMatches
        .slice(0, 5)
        .map((r) => r.id.slice(0, 8))
        .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
    };
  }

  return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
}

/**
 * Live state wins over the stored record of the same agent: the stored runtime session ID can be
 * stale after the provider rotates its session. An agent marked internal in either place is skipped.
 */
function resolveProviderSessionId(
  identifier: string,
  sources: AgentIdentifierSources,
): AgentIdentifierResolution | null {
  const internalIds = new Set<string>();
  for (const agent of [...sources.live, ...sources.stored]) {
    if (agent.internal) {
      internalIds.add(agent.id);
    }
  }
  const storedTitles = new Map(sources.stored.map((record) => [record.id, record.title]));
  const candidates = [
    ...sources.live.map((agent) => ({
      id: agent.id,
      title: storedTitles.get(agent.id) ?? agent.config?.title ?? null,
      runtimeInfo: agent.runtimeInfo,
      persistence: agent.persistence,
    })),
    ...sources.stored,
  ].filter((candidate) => !internalIds.has(candidate.id));

  const matches = findAgentsByProviderSessionId(candidates, identifier);
  if (matches.length === 1) {
    return { ok: true, agentId: matches[0].id };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      notFound: false,
      error: formatAmbiguousProviderSessionIdError(identifier, matches),
    };
  }
  return null;
}
