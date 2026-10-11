import type { Command } from "commander";
import type { AgentStatusResult } from "@getpaseo/protocol/messages";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export const agentStatusSchema: OutputSchema<AgentStatusResult> = {
  idField: (result) => result.snapshot.id,
  columns: [
    { header: "ID", field: (result) => result.snapshot.id },
    { header: "STATUS", field: "status" },
    { header: "PROVIDER", field: (result) => result.snapshot.provider },
    { header: "NAME", field: (result) => result.snapshot.title ?? "-" },
    { header: "CWD", field: (result) => result.snapshot.cwd },
  ],
};

export interface AgentStatusOptions extends CommandOptions {
  host?: string;
}

export function addAgentStatusOptions(command: Command): Command {
  return command
    .description("Return the complete current or stored agent snapshot")
    .argument("<agent-id>", "Exact agent ID");
}

export async function runAgentStatusCommand(
  agentId: string,
  options: AgentStatusOptions,
  _command: Command,
): Promise<SingleResult<AgentStatusResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(agentStatus): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.agentStatus !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support agent status snapshots.",
        details: "Update the daemon before reading agent status.",
      } satisfies CommandError;
    }
    const result = await client.getAgentStatus(agentId);
    return { type: "single", data: result, schema: agentStatusSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
