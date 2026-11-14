import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import type { CommandOptions, SingleResult } from "../../output/index.js";

interface AckResult {
  agentIds: string[];
  acknowledgedCount: number;
}

type AckClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "fetchAgent" | "clearAgentAttention" | "close"
>;

export function addAckOptions(command: Command): Command {
  return command
    .description("Acknowledge agent attention notifications")
    .argument("<ids...>", "Agent IDs, prefixes, or full session IDs");
}

export async function runAckCommand(
  ids: string[],
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AckResult>> {
  return acknowledgeAgents(ids, options);
}

export async function acknowledgeAgents(
  ids: string[],
  options: CommandOptions,
  connect: (options: Parameters<typeof connectToDaemon>[0]) => Promise<AckClient> = connectToDaemon,
): Promise<SingleResult<AckResult>> {
  if (ids.length === 0)
    throw { code: "MISSING_AGENT_ID", message: "At least one agent ID is required." };
  const client = await connect({ target: options.daemonTarget });
  try {
    const resolved: string[] = [];
    for (const id of ids) resolved.push(await resolveAgentTarget(client, id));
    const agentIds = [...new Set(resolved)];
    await client.clearAgentAttention(agentIds);
    return {
      type: "single",
      data: { agentIds, acknowledgedCount: agentIds.length },
      schema: {
        idField: (item) => item.agentIds.join("\n"),
        columns: [{ header: "ACKNOWLEDGED", field: "acknowledgedCount" }],
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
