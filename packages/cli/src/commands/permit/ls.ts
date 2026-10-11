import type { Command } from "commander";
import type { AgentPendingPermissionPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";

/** Permission list item for display */
export interface PermissionListItem extends AgentPendingPermissionPayload {
  id: string;
  agentId: string;
  agentShortId: string;
  name: string;
  description: string;
}

/** Schema for permit ls output */
export const permitLsSchema: OutputSchema<PermissionListItem> = {
  idField: "id",
  columns: [
    { header: "AGENT", field: "agentShortId", width: 12 },
    { header: "REQ_ID", field: (item) => item.id.slice(0, 8), width: 12 },
    { header: "TOOL", field: "name", width: 20 },
    { header: "DESCRIPTION", field: "description", width: 50 },
  ],
};

/** Add legacy table fields to the complete normalized permission record. */
function toListItem(permission: AgentPendingPermissionPayload): PermissionListItem {
  return {
    ...permission,
    id: permission.request.id,
    agentShortId: permission.agentId.slice(0, 7),
    name: permission.request.name,
    description: permission.request.description ?? "-",
  };
}

export type PermitLsResult = ListResult<PermissionListItem>;

/** Add the CLI's table fields while retaining every normalized MCP field. */
export function listPendingPermissions(
  permissions: AgentPendingPermissionPayload[],
): PermitLsResult {
  const items = permissions.map(toListItem);
  return {
    type: "list",
    data: items,
    schema: permitLsSchema,
  };
}

export interface PermitLsOptions extends CommandOptions {
  host?: string;
}

export async function runLsCommand(
  options: PermitLsOptions,
  _command: Command,
): Promise<PermitLsResult> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // COMPAT(permissionList): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.permissionList !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support complete permission listing.",
        details: "Update the daemon before listing permission requests.",
      } satisfies CommandError;
    }
    const { permissions } = await client.listPendingAgentPermissions();
    return listPendingPermissions(permissions);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "LIST_PERMISSIONS_FAILED",
      message: `Failed to list permissions: ${message}`,
    };
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}
