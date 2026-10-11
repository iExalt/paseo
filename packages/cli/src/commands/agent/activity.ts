import type { Command } from "commander";
import type { AgentActivityResult } from "@getpaseo/protocol/messages";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export const agentActivitySchema: OutputSchema<AgentActivityResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "UPDATES", field: "updateCount" },
    { header: "MODE", field: (activity) => activity.currentModeId ?? "-" },
    { header: "ACTIVITY", field: "content" },
  ],
};

export interface AgentActivityOptions extends CommandOptions {
  host?: string;
  limit?: string;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    throw {
      code: "INVALID_ACTIVITY_LIMIT",
      message: "--limit must be a finite number",
    } satisfies CommandError;
  }
  return limit;
}

export function addAgentActivityOptions(command: Command): Command {
  return command
    .description("Show an agent's recent conversation and activity summary")
    .argument("<agent-id>", "Exact agent ID")
    .option(
      "--limit <number>",
      "Limit curated activity entries; zero or a negative value includes all",
    );
}

export async function runAgentActivityCommand(
  agentId: string,
  options: AgentActivityOptions,
  _command: Command,
): Promise<SingleResult<AgentActivityResult>> {
  const limit = parseLimit(options.limit);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(agentActivity): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.agentActivity !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support curated agent activity.",
        details: "Update the daemon before reading curated agent activity.",
      } satisfies CommandError;
    }
    const result = await client.getAgentActivity({
      agentId,
      ...(limit !== undefined ? { limit } : {}),
    });
    return { type: "single", data: result, schema: agentActivitySchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
