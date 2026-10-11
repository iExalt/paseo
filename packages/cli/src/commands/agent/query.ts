import type { Command } from "commander";
import {
  AgentStatusSchema,
  type AgentDirectoryQueryRequest,
  type AgentListItemPayload,
} from "@getpaseo/protocol/messages";
import type { CommandError, CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";

export const agentQuerySchema: OutputSchema<AgentListItemPayload> = {
  idField: "id",
  columns: [
    { header: "ID", field: "shortId", width: 12 },
    { header: "NAME", field: (agent) => agent.title ?? "-", width: 24 },
    { header: "PROVIDER", field: "provider", width: 14 },
    { header: "MODEL", field: (agent) => agent.model ?? "-", width: 22 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "CWD", field: "cwd", width: 32 },
  ],
};

export interface AgentQueryOptions extends CommandOptions {
  callerAgent?: string;
  cwd?: string;
  includeArchived?: boolean;
  includeBackground?: boolean;
  sinceHours?: string;
  status?: string[];
  limit?: string;
}

interface IntegerOptionInput {
  value: string | undefined;
  name: string;
  min: number;
  max: number;
  defaultValue: number;
}

function parseIntegerOption({ value, name, min, max, defaultValue }: IntegerOptionInput): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw {
      code: "INVALID_AGENT_QUERY",
      message: `--${name} must be an integer from ${min} to ${max}`,
    } satisfies CommandError;
  }
  return parsed;
}

function parseStatuses(
  statuses: string[] | undefined,
): NonNullable<AgentDirectoryQueryRequest["statuses"]> {
  const parsedStatuses: NonNullable<AgentDirectoryQueryRequest["statuses"]> = [];
  for (const status of statuses ?? []) {
    const parsed = AgentStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw {
        code: "INVALID_AGENT_QUERY",
        message: `Unknown agent status: ${status}`,
        details: `Expected one of ${AgentStatusSchema.options.join(", ")}`,
      } satisfies CommandError;
    }
    parsedStatuses.push(parsed.data);
  }
  return parsedStatuses;
}

export function addAgentQueryOptions(command: Command): Command {
  return command
    .description("Find agents by scope, age, status, and visibility")
    .option("--caller-agent <id>", "Use an agent caller directory as the default scope")
    .option("--cwd <path>", "Restrict results to this directory and its descendants")
    .option("--include-archived", "Include archived agents")
    .option("--include-background", "Include background workspace agents")
    .option("--since-hours <hours>", "Maximum age of archived agent activity (default: 48)")
    .option("--status <status>", "Filter by status (repeatable)", collectMultiple, [])
    .option("--limit <n>", "Maximum results (1-200; default: 50)");
}

export async function runAgentQueryCommand(
  options: AgentQueryOptions,
  _command: Command,
): Promise<ListResult<AgentListItemPayload>> {
  const sinceHours = parseIntegerOption({
    value: options.sinceHours,
    name: "since-hours",
    min: 1,
    max: 720,
    defaultValue: 48,
  });
  const limit = parseIntegerOption({
    value: options.limit,
    name: "limit",
    min: 1,
    max: 200,
    defaultValue: 50,
  });
  const statuses = parseStatuses(options.status);
  const requestedCallerId = options.callerAgent?.trim();
  if (options.callerAgent !== undefined && !requestedCallerId) {
    throw {
      code: "INVALID_AGENT_QUERY",
      message: "--caller-agent cannot be empty",
    } satisfies CommandError;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(agentDirectoryQuery): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.agentDirectoryQuery !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support agent queries.",
        details: "Update the daemon before querying agents.",
      } satisfies CommandError;
    }
    const callerAgentId = requestedCallerId || (await resolveCallerAgentId(client));
    const agents = await client.queryAgentDirectory({
      ...(options.includeBackground ? { includeBackground: true } : {}),
      ...(options.includeArchived ? { includeArchived: true } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(callerAgentId ? { callerAgentId } : {}),
      sinceHours,
      ...(statuses.length > 0 ? { statuses } : {}),
      limit,
    });
    return { type: "list", data: agents, schema: agentQuerySchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
