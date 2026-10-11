import type { Command } from "commander";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, CommandError } from "../../output/index.js";
import {
  permitResponseSchema,
  selectPermissionRequests,
  toPermissionResponseItem,
  type PermissionResponseItem,
} from "./allow.js";

export type PermitDenyResult = ListResult<PermissionResponseItem>;

export interface PermitDenyOptions extends CommandOptions {
  all?: boolean;
  message?: string;
  interrupt?: boolean;
  selectedActionId?: string;
  host?: string;
}

export async function runDenyCommand(
  agentIdOrPrefix: string,
  reqId: string | undefined,
  options: PermitDenyOptions,
  _command: Command,
): Promise<PermitDenyResult> {
  const hasSingleRequestFields = options.selectedActionId !== undefined;
  if (hasSingleRequestFields && (!reqId || options.all)) {
    throw {
      code: "SINGLE_PERMISSION_REQUIRED",
      message: "Permission response fields require one request ID and cannot be used with --all.",
      details: "Specify <req_id> and omit --all.",
    } satisfies CommandError;
  }

  // Validate arguments
  if (!options.all && !reqId) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Request ID is required unless --all is specified",
      details: "Usage: paseo permit deny <agent> <req_id> or paseo permit deny <agent> --all",
    };
    throw error;
  }

  const response = AgentPermissionResponseSchema.parse({
    behavior: "deny",
    ...(options.selectedActionId !== undefined
      ? { selectedActionId: options.selectedActionId }
      : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.interrupt ? { interrupt: true } : {}),
  });

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const fetchResult = await client.fetchAgent({ agentId: agentIdOrPrefix });
    if (!fetchResult) {
      await client.close();
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdOrPrefix}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const agent = fetchResult.agent;
    const resolvedAgentId = agent.id;

    // Get pending permissions for this agent
    const pendingPermissions = agent.pendingPermissions || [];
    if (pendingPermissions.length === 0) {
      await client.close();
      const error: CommandError = {
        code: "NO_PENDING_PERMISSIONS",
        message: `No pending permissions for agent ${agent.id.slice(0, 7)}`,
      };
      throw error;
    }

    // Determine which permissions to deny
    const permissionsToDeny = selectPermissionRequests({
      pendingPermissions,
      requestId: reqId,
      all: options.all,
      requireUnambiguousPrefix: hasSingleRequestFields,
    });

    // Deny permissions
    const results: PermissionResponseItem[] = await Promise.all(
      permissionsToDeny.map(async (permission) => {
        await client.respondToPermissionAndWait(resolvedAgentId, permission.id, {
          ...response,
        });
        return toPermissionResponseItem(resolvedAgentId, permission, "denied");
      }),
    );

    await client.close();

    return {
      type: "list",
      data: results,
      schema: permitResponseSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    // Re-throw CommandErrors
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DENY_PERMISSION_FAILED",
      message: `Failed to deny permission: ${message}`,
    };
    throw error;
  }
}
