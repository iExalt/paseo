import { describe, expect, test, vi } from "vitest";
import { resolveExactAgentTarget, type ExactAgentTargetClient } from "./agent-target.js";

function clientReturning(
  agent: {
    id: string;
    runtimeInfo?: { sessionId: string | null };
    persistence?: { sessionId: string } | null;
  } | null,
) {
  const fetchAgent = vi.fn(async () => (agent ? { agent } : null));
  return { client: { fetchAgent } as unknown as ExactAgentTargetClient, fetchAgent };
}

describe("resolveExactAgentTarget", () => {
  test("maps a full session ID to the agent's Paseo ID", async () => {
    const { client, fetchAgent } = clientReturning({
      id: "agent-1",
      runtimeInfo: { sessionId: "thread-abc" },
    });

    await expect(resolveExactAgentTarget(client, " thread-abc ")).resolves.toBe("agent-1");
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "thread-abc" });
  });

  test("keeps an exact Paseo ID", async () => {
    const { client } = clientReturning({ id: "agent-1", persistence: null });

    await expect(resolveExactAgentTarget(client, "agent-1")).resolves.toBe("agent-1");
  });

  test("passes a prefix or title through so exact-ID commands stay exact", async () => {
    const { client } = clientReturning({ id: "agent-1", persistence: { sessionId: "thread-abc" } });

    await expect(resolveExactAgentTarget(client, "agent")).resolves.toBe("agent");
  });

  test("passes an unknown ID through for the daemon to reject", async () => {
    const { client } = clientReturning(null);

    await expect(resolveExactAgentTarget(client, "missing")).resolves.toBe("missing");
  });

  test("propagates the daemon's ambiguity error", async () => {
    const fetchAgent = vi.fn(async () => {
      throw new Error('Session ID "thread-dup" matches 2 agents.');
    });

    await expect(
      resolveExactAgentTarget({ fetchAgent } as unknown as ExactAgentTargetClient, "thread-dup"),
    ).rejects.toThrow("matches 2 agents");
  });
});
