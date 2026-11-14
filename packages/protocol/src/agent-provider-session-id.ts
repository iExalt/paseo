/**
 * Provider session IDs as agent targets.
 *
 * Every agent has a Paseo ID. Most also have the provider's own ID for the conversation: Claude
 * Code's session ID, Codex's thread ID, and so on. The app's "Copy session ID" action copies that
 * provider ID, and the daemon and CLI accept it wherever they accept an agent target. Both sides
 * use this module so the ID that gets copied is the ID that resolves.
 */

/** The fields an agent representation (stored record, live agent, wire payload) carries. */
export interface ProviderSessionIdSource {
  runtimeInfo?: { sessionId?: string | null } | null;
  persistence?: { sessionId?: string | null } | null;
}

export interface ProviderSessionIdCandidate extends ProviderSessionIdSource {
  id: string;
  title?: string | null;
}

/**
 * The provider's own ID for the conversation. The live runtime ID wins over the persisted handle,
 * which can lag behind after the provider rotates its session.
 */
export function getProviderSessionId(agent: ProviderSessionIdSource): string | null {
  return agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
}

/**
 * Agents whose effective provider session ID equals `identifier` exactly. Candidates with the same
 * Paseo ID are one agent; the first occurrence wins, so pass live representations before stored
 * ones. Prefix matching is deliberately absent.
 */
export function findAgentsByProviderSessionId<T extends ProviderSessionIdCandidate>(
  candidates: Iterable<T>,
  identifier: string,
): T[] {
  const seen = new Set<string>();
  const matches: T[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    if (identifier && getProviderSessionId(candidate) === identifier) {
      matches.push(candidate);
    }
  }
  return matches;
}

/** Error text for a provider session ID that more than one agent holds. Lists every match. */
export function formatAmbiguousProviderSessionIdError(
  identifier: string,
  matches: ReadonlyArray<ProviderSessionIdCandidate>,
): string {
  const lines = matches.map((match) => {
    const title = match.title?.trim();
    return `  ${match.id}${title ? `  ${title}` : ""}`;
  });
  return [
    `Session ID "${identifier}" matches ${matches.length} agents. Use a Paseo agent ID instead:`,
    ...lines,
  ].join("\n");
}
