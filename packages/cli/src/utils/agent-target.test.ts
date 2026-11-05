import { describe, expect, test } from "vitest";
import { resolveAgentTarget, type AgentTargetClient } from "./agent-target.js";

function clientReturning(agent: { id: string } | null) {
  const requestedIds: string[] = [];
  const client: AgentTargetClient = {
    async fetchAgent({ agentId }) {
      requestedIds.push(agentId);
      return agent ? { agent } : null;
    },
  };
  return { client, requestedIds };
}

describe("resolveAgentTarget", () => {
  test.each(["agent-1", "agent", "thread-abc", "Build docs"])(
    "returns the daemon's resolved Paseo ID for %s",
    async (target) => {
      const { client, requestedIds } = clientReturning({ id: "agent-1" });
      await expect(resolveAgentTarget(client, ` ${target} `)).resolves.toBe("agent-1");
      expect(requestedIds).toEqual([target]);
    },
  );

  test("explains the daemon scope and provider-session namespace for an unknown ID", async () => {
    const { client } = clientReturning(null);
    await expect(resolveAgentTarget(client, "missing")).rejects.toEqual({
      code: "AGENT_NOT_FOUND",
      message: "No agent found matching: missing",
      details:
        "Use `paseo agent ls --all --global` with the same --host or --home to check the selected daemon. Paseo agent IDs accept unambiguous prefixes; provider session IDs must be complete and already known to this daemon. Use `paseo import` to import a provider session.",
    });
  });

  test("rejects an empty target before asking the daemon", async () => {
    const { client, requestedIds } = clientReturning(null);
    await expect(resolveAgentTarget(client, " ")).rejects.toEqual({
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required.",
    });
    expect(requestedIds).toEqual([]);
  });

  test.each([
    'Session ID "thread-dup" matches 2 agents.',
    'Agent identifier "agent" is ambiguous (agent-1, agent-2)',
  ])("propagates daemon ambiguity: %s", async (message) => {
    const error = new Error(message);
    const client: AgentTargetClient = {
      async fetchAgent() {
        throw error;
      },
    };
    await expect(resolveAgentTarget(client, "agent")).rejects.toBe(error);
  });
});
