import { getProviderSessionId } from "@getpaseo/protocol/agent-provider-session-id";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type SessionAgent = Pick<
  Agent,
  "id" | "workspaceId" | "archivedAt" | "parentAgentId" | "lastActivityAt" | "persistence"
> & { runtimeInfo?: Pick<NonNullable<Agent["runtimeInfo"]>, "sessionId"> };

// The CLI and daemon resolve this same ID back to the agent, so copy and resolution share one rule.
export { getProviderSessionId };

/**
 * Picks the provider session a workspace-level "copy session ID" action should copy.
 *
 * A workspace can hold several agents, so the caller's preferred agent (the focused tab) wins when
 * it lives in this workspace. Otherwise the most recently active unarchived top-level agent wins;
 * subagents are skipped because their session is rarely the one you want to resume.
 */
export function resolveWorkspaceProviderSessionId(input: {
  agents: Iterable<SessionAgent> | undefined;
  workspaceId: string | null | undefined;
  preferredAgentId?: string | null;
}): string | null {
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!input.agents || !workspaceId) {
    return null;
  }

  let latest: { sessionId: string; activityAt: number } | null = null;
  for (const agent of input.agents) {
    if (agent.archivedAt || normalizeWorkspaceOpaqueId(agent.workspaceId) !== workspaceId) {
      continue;
    }
    const sessionId = getProviderSessionId(agent);
    if (!sessionId) {
      continue;
    }
    if (agent.id === input.preferredAgentId) {
      return sessionId;
    }
    if (agent.parentAgentId) {
      continue;
    }
    const activityAt = agent.lastActivityAt.getTime();
    if (!latest || activityAt > latest.activityAt) {
      latest = { sessionId, activityAt };
    }
  }
  return latest?.sessionId ?? null;
}
