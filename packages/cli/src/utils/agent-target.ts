export interface AgentTargetClient {
  fetchAgent(input: { agentId: string }): Promise<{ agent: { id: string } } | null>;
}

/**
 * Resolve through the daemon so prefixes, titles and full provider session IDs use its
 * existing lookup and ambiguity rules before calling an RPC that requires a Paseo ID.
 */
export async function resolveAgentTarget(
  client: AgentTargetClient,
  target: string,
): Promise<string> {
  const trimmed = target.trim();
  if (!trimmed) {
    throw { code: "MISSING_AGENT_ID", message: "Agent ID is required." };
  }
  const agent = (await client.fetchAgent({ agentId: trimmed }))?.agent;
  if (!agent) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `No agent found matching: ${trimmed}`,
      details:
        "Use `paseo agent ls --all --global` with the same --host or --home to check the selected daemon. Paseo agent IDs accept unambiguous prefixes; provider session IDs must be complete and already known to this daemon. Use `paseo import` to import a provider session.",
    };
  }
  return agent.id;
}
