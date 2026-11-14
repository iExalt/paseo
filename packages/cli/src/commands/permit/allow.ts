import type { Command } from "commander";
import { z } from "zod";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import { settlePermissionResponses } from "./response.js";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";

/** Permission response item for display */
export interface PermissionResponseItem {
  requestId: string;
  agentId: string;
  agentShortId: string;
  name: string;
  result: "allowed" | "denied" | "failed" | "unconfirmed";
  status: "confirmed" | "failed" | "unconfirmed";
  error?: string;
}

/** Schema for permit allow/deny output */
export const permitResponseSchema: OutputSchema<PermissionResponseItem> = {
  idField: "requestId",
  columns: [
    { header: "REQUEST ID", field: (item) => shortPermissionId(item.requestId), width: 12 },
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
    { header: "STATUS", field: "status" },
    { header: "ERROR", field: "error" },
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
    status: "confirmed",
  };
}

interface ResolvePermissionRequestParams {
  pendingPermissions: readonly AgentPermissionRequest[];
  requestId: string;
}

const PERMISSION_ID_PREFIX = "permission-";

/** The short request ID `permit ls` shows: providers prefix every ID with `permission-`. */
export function shortPermissionId(id: string): string {
  return (id.startsWith(PERMISSION_ID_PREFIX) ? id.slice(PERMISSION_ID_PREFIX.length) : id).slice(
    0,
    8,
  );
}

/** Exact ID first, then a unique prefix of the full ID or of the ID without `permission-`. */
export function resolvePermissionRequest({
  pendingPermissions,
  requestId,
}: ResolvePermissionRequestParams): AgentPermissionRequest {
  const exactMatch = pendingPermissions.find((permission) => permission.id === requestId);
  if (exactMatch) return exactMatch;

  const prefixMatches = pendingPermissions.filter(
    (permission) =>
      permission.id.startsWith(requestId) ||
      (permission.id.startsWith(PERMISSION_ID_PREFIX) &&
        permission.id.slice(PERMISSION_ID_PREFIX.length).startsWith(requestId)),
  );
  if (prefixMatches.length > 1) {
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
    details: `Available requests: ${pendingPermissions.map((request) => shortPermissionId(request.id)).join(", ")}`,
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
}: SelectPermissionRequestsParams): AgentPermissionRequest[] {
  if (!requestId || all) return [...pendingPermissions];
  return [resolvePermissionRequest({ pendingPermissions, requestId })];
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
): { response: AgentPermissionResponse } {
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

  return { response };
}

export interface PermitClient {
  fetchAgent(options: { agentId: string }): Promise<{
    agent: { id: string; pendingPermissions?: AgentPermissionRequest[] };
  } | null>;
  respondToPermissionAndWait(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type PermitClientConnector = (
  options: Parameters<typeof connectToDaemon>[0],
) => Promise<PermitClient>;

function validateQuestionResponse(
  permission: AgentPermissionRequest,
  response: AgentPermissionResponse,
): void {
  if (permission.kind !== "question" || response.behavior !== "allow") return;
  const questions = z
    .array(
      z.object({
        header: z.string().min(1),
        allowEmpty: z.boolean().optional(),
      }),
    )
    .min(1)
    .safeParse(permission.input?.questions);
  const answers = z.record(z.string(), z.string()).safeParse(response.updatedInput?.answers);
  if (
    !questions.success ||
    !answers.success ||
    questions.data.some(
      (question) =>
        !Object.hasOwn(answers.data, question.header) ||
        (!question.allowEmpty && !answers.data[question.header].trim()),
    ) ||
    Object.keys(answers.data).some(
      (header) => !questions.data.some((question) => question.header === header),
    )
  ) {
    throw {
      code: "INVALID_QUESTION_ANSWERS",
      message: `Invalid answers for question request ${permission.id}; no responses were sent.`,
      details:
        'Use --input \'{"answers":{"Question 1":"chosen label or free text"}}\'. Copy every header from request.input.questions in "paseo permit ls --json"; each answer must be a nonblank string unless that question allows an empty answer.',
    } satisfies CommandError;
  }
}

export function createAllowCommand(connect: PermitClientConnector = connectToDaemon) {
  return async function runAllowCommand(
    agentIdOrPrefix: string,
    reqId: string | undefined,
    options: PermitAllowOptions,
    _command: Command,
  ): Promise<PermitAllowResult> {
    const { response } = createAllowResponse(reqId, options);

    const client = await connect({ target: options.daemonTarget });

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
      });

      return await settlePermissionResponses({
        client,
        agentId: resolvedAgentId,
        permissions: permissionsToAllow,
        response,
        validate: validateQuestionResponse,
      });
    } catch (err) {
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
    } finally {
      await client.close().catch(() => {});
    }
  };
}

export const runAllowCommand = createAllowCommand();
