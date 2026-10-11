import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface AgentCloseResult {
  agentId: string;
  status: "closed";
}

const closeSchema: OutputSchema<AgentCloseResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
  ],
};

export function addCloseOptions(cmd: Command): Command {
  return cmd
    .description("Close an agent session while preserving its history")
    .argument("<id>", "Agent ID or unambiguous ID prefix");
}

export async function runCloseCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command?: Command,
): Promise<SingleResult<AgentCloseResult>> {
  const idQuery = agentIdArg.trim();
  if (!idQuery) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent close <id-or-prefix>",
    } satisfies CommandError;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // COMPAT(agentClose): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.agentClose !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to close agent sessions.",
        details: "The connected daemon does not advertise agentClose support.",
      } satisfies CommandError;
    }

    const agentIds: string[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchAgentHistory({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      agentIds.push(...payload.entries.map((entry) => entry.agent.id));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);

    const agentId = resolveCloseAgentId(idQuery, agentIds);
    await client.closeAgent(agentId);

    return {
      type: "single",
      data: { agentId, status: "closed" },
      schema: closeSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function resolveCloseAgentId(idArg: string, agentIds: string[]): string {
  const exactMatch = agentIds.find((agentId) => agentId === idArg);
  if (exactMatch) return exactMatch;

  const prefixMatches = [
    ...new Set(agentIds.filter((agentId) => agentId.toLowerCase().startsWith(idArg.toLowerCase()))),
  ];
  if (prefixMatches.length === 1 && prefixMatches[0]) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw {
      code: "AMBIGUOUS_AGENT_ID",
      message: `Agent ID prefix is ambiguous: ${idArg}`,
      details: `Matches: ${prefixMatches.join(", ")}`,
    } satisfies CommandError;
  }

  throw {
    code: "AGENT_NOT_FOUND",
    message: `No agent found matching: ${idArg}`,
    details: "Use `paseo ls` to list available agents.",
  } satisfies CommandError;
}
