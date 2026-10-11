import type { AgentPendingPermissionPayload } from "@getpaseo/protocol/messages";
import type { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import { sanitizePermissionRequest } from "./mcp-shared.js";

export interface ListPendingAgentPermissionsParams {
  agentManager: Pick<AgentManager, "listAgents">;
}

export function listPendingAgentPermissions({
  agentManager,
}: ListPendingAgentPermissionsParams): AgentPendingPermissionPayload[] {
  return agentManager.listAgents().flatMap((agent) => {
    const payload = toAgentPayload(agent);
    return payload.pendingPermissions.map((request) => ({
      agentId: agent.id,
      status: payload.status,
      request: sanitizePermissionRequest(request),
    }));
  });
}
