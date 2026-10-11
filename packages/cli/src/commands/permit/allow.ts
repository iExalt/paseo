import type { Command } from "commander";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";

/** Permission response item for display */
export interface PermissionResponseItem {
  requestId: string;
  agentId: string;
  agentShortId: string;
  name: string;
  result: string;
}

/** Schema for permit allow/deny output */
export const permitResponseSchema: OutputSchema<PermissionResponseItem> = {
  idField: "requestId",
  columns: [
    { header: "REQUEST ID", field: (item) => item.requestId.slice(0, 8), width: 12 },
    { header: "AGENT", field: "agentShortId", width: 10 },
    { header: "TOOL", field: "name", width: 20 },
    {
      header: "RESULT",
      field: "result",
      width: 10,
      color: (value) => {
        if (value === "allowed") return "green";
        if (value === "denied") return "red";
        return undefined;
      },
    },
  ],
};

/** Transform a permission the agent answered to a response item */
export function toPermissionResponseItem(
  agentId: string,
  permission: AgentPermissionRequest,
  result: "allowed" | "denied",
): PermissionResponseItem {
  return {
    requestId: permission.id,
    agentId,
    agentShortId: agentId.slice(0, 7),
    name: permission.name,
    result,
  };
}

interface ResolvePermissionRequestParams {
  pendingPermissions: readonly AgentPermissionRequest[];
  requestId: string;
  requireUnambiguousPrefix?: boolean;
}

export function resolvePermissionRequest({
  pendingPermissions,
  requestId,
  requireUnambiguousPrefix = false,
}: ResolvePermissionRequestParams): AgentPermissionRequest {
  if (requireUnambiguousPrefix) {
    const exactMatch = pendingPermissions.find((permission) => permission.id === requestId);
    if (exactMatch) return exactMatch;
  }

  const prefixMatches = pendingPermissions.filter((permission) =>
    permission.id.startsWith(requestId),
  );
  if (requireUnambiguousPrefix && prefixMatches.length > 1) {
    throw {
      code: "AMBIGUOUS_PERMISSION_ID",
      message: `Permission request ID prefix is ambiguous: ${requestId}`,
      details: `Matches: ${prefixMatches.map((permission) => permission.id).join(", ")}`,
    } satisfies CommandError;
  }

  const permission = prefixMatches[0];
  if (permission) return permission;

  throw {
    code: "PERMISSION_NOT_FOUND",
    message: `Permission request not found: ${requestId}`,
    details: `Available requests: ${pendingPermissions.map((request) => request.id.slice(0, 8)).join(", ")}`,
  } satisfies CommandError;
}

interface SelectPermissionRequestsParams extends Omit<ResolvePermissionRequestParams, "requestId"> {
  requestId?: string;
  all?: boolean;
}

export function selectPermissionRequests({
  pendingPermissions,
  requestId,
  all,
  requireUnambiguousPrefix,
}: SelectPermissionRequestsParams): AgentPermissionRequest[] {
  if (!requestId || all) return [...pendingPermissions];
  return [resolvePermissionRequest({ pendingPermissions, requestId, requireUnambiguousPrefix })];
}

export type PermitAllowResult = ListResult<PermissionResponseItem>;

export interface PermitAllowOptions extends CommandOptions {
  all?: boolean;
  input?: string;
  selectedActionId?: string;
  updatedPermissions?: string;
  host?: string;
}

function createAllowResponse(
  reqId: string | undefined,
  options: PermitAllowOptions,
): { response: AgentPermissionResponse; hasSingleRequestFields: boolean } {
  const hasSingleRequestFields =
    options.selectedActionId !== undefined || options.updatedPermissions !== undefined;
  if (hasSingleRequestFields && (!reqId || options.all)) {
    throw {
      code: "SINGLE_PERMISSION_REQUIRED",
      message: "Permission response fields require one request ID and cannot be used with --all.",
      details: "Specify <req_id> and omit --all.",
    } satisfies CommandError;
  }

  let updatedInput: unknown;
  if (options.input !== undefined) {
    try {
      updatedInput = JSON.parse(options.input);
    } catch (err) {
      const error: CommandError = {
        code: "INVALID_JSON",
        message: `Invalid JSON for --input: ${err instanceof Error ? err.message : String(err)}`,
        details: 'Provide valid JSON, e.g., --input \'{"key": "value"}\'',
      };
      throw error;
    }
  }
  let updatedPermissions: unknown;
  if (options.updatedPermissions !== undefined) {
    try {
      updatedPermissions = JSON.parse(options.updatedPermissions);
    } catch (err) {
      throw {
        code: "INVALID_JSON",
        message: `Invalid JSON for --updated-permissions: ${err instanceof Error ? err.message : String(err)}`,
        details: "Provide a JSON array of permission updates.",
      } satisfies CommandError;
    }
  }
  const response = AgentPermissionResponseSchema.parse({
    behavior: "allow",
    ...(options.selectedActionId !== undefined
      ? { selectedActionId: options.selectedActionId }
      : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {}),
    ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
  });

  return { response, hasSingleRequestFields };
}

export async function runAllowCommand(
  agentIdOrPrefix: string,
  reqId: string | undefined,
  options: PermitAllowOptions,
  _command: Command,
): Promise<PermitAllowResult> {
  const { response, hasSingleRequestFields } = createAllowResponse(reqId, options);

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

    // Determine which permissions to allow
    // No request ID means allow all, preserving the existing CLI default.
    const permissionsToAllow = selectPermissionRequests({
      pendingPermissions,
      requestId: reqId,
      all: options.all,
      requireUnambiguousPrefix: hasSingleRequestFields,
    });

    // Allow permissions
    const results: PermissionResponseItem[] = await Promise.all(
      permissionsToAllow.map(async (permission) => {
        await client.respondToPermissionAndWait(resolvedAgentId, permission.id, {
          ...response,
        });
        return toPermissionResponseItem(resolvedAgentId, permission, "allowed");
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
      code: "ALLOW_PERMISSION_FAILED",
      message: `Failed to allow permission: ${message}`,
    };
    throw error;
  }
}
