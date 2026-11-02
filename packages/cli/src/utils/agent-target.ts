import {
  getProviderSessionId,
  type ProviderSessionIdCandidate,
} from "@getpaseo/protocol/agent-provider-session-id";

export interface ExactAgentTargetClient {
  fetchAgent(input: { agentId: string }): Promise<{ agent: ProviderSessionIdCandidate } | null>;
}

/**
 * For options that take an exact agent ID: also accept the agent's full provider session ID (the ID
 * the app's "Copy session ID" copies) and return its Paseo ID. Anything else, including an ID
 * prefix or title, passes through unchanged so the daemon keeps its exact-ID semantics and errors.
 * A session ID several agents hold makes the daemon's lookup throw, listing them.
 */
export async function resolveExactAgentTarget(
  client: ExactAgentTargetClient,
  target: string,
): Promise<string> {
  const trimmed = target.trim();
  if (!trimmed) {
    return target;
  }
  const agent = (await client.fetchAgent({ agentId: trimmed }))?.agent;
  if (agent && (agent.id === trimmed || getProviderSessionId(agent) === trimmed)) {
    return agent.id;
  }
  return target;
}
