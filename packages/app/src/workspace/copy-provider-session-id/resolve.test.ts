import { describe, expect, it } from "vitest";
import { resolveWorkspaceProviderSessionId } from "./resolve";

type Fixture = Parameters<typeof resolveWorkspaceProviderSessionId>[0]["agents"] extends
  | Iterable<infer A>
  | undefined
  ? A
  : never;

function agent(input: Partial<Fixture> & { id: string; sessionId?: string | null }): Fixture {
  const { sessionId = `session-${input.id}`, ...rest } = input;
  return {
    workspaceId: "ws-1",
    archivedAt: null,
    parentAgentId: null,
    lastActivityAt: new Date(0),
    persistence: sessionId ? { provider: "claude", sessionId } : null,
    ...rest,
  };
}

function resolve(agents: Fixture[], preferredAgentId?: string) {
  return resolveWorkspaceProviderSessionId({ agents, workspaceId: "ws-1", preferredAgentId });
}

describe("resolveWorkspaceProviderSessionId", () => {
  it("prefers the focused agent, even a subagent, over a more recent workspace agent", () => {
    const agents = [
      agent({ id: "recent", lastActivityAt: new Date(2) }),
      agent({ id: "focused", parentAgentId: "recent", lastActivityAt: new Date(1) }),
    ];
    expect(resolve(agents, "focused")).toBe("session-focused");
  });

  it("falls back to the most recent eligible top-level agent in the workspace", () => {
    const agents = [
      agent({ id: "older", lastActivityAt: new Date(1) }),
      agent({ id: "newest-elsewhere", workspaceId: "ws-2", lastActivityAt: new Date(9) }),
      agent({ id: "newest-archived", archivedAt: new Date(9), lastActivityAt: new Date(9) }),
      agent({ id: "newest-subagent", parentAgentId: "older", lastActivityAt: new Date(9) }),
      agent({ id: "newest-unstarted", sessionId: null, lastActivityAt: new Date(9) }),
      agent({ id: "newer", lastActivityAt: new Date(2) }),
    ];
    expect(resolve(agents, "newest-elsewhere")).toBe("session-newer");
  });

  it("prefers the live runtime session over the persisted handle", () => {
    const resumed = {
      ...agent({ id: "resumed", sessionId: "persisted" }),
      runtimeInfo: { sessionId: "live" },
    };
    expect(resolve([resumed])).toBe("live");
  });

  it("returns null when no agent in the workspace has a session", () => {
    expect(resolve([agent({ id: "draft", sessionId: null })])).toBeNull();
  });
});
