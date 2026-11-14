import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgentEntry, type AgentLookupClient } from "../../utils/agent-directory.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent archive command */
export interface AgentArchiveResult {
  agentId: string;
  status: "archived";
  archivedAt: string;
}

/** Schema for archive command output */
export const archiveSchema: OutputSchema<AgentArchiveResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "ARCHIVED AT", field: "archivedAt" },
  ],
};

export function addArchiveOptions(cmd: Command): Command {
  return cmd
    .description("Archive an agent and its workspace when it is the last unarchived agent")
    .argument("<id>", "Agent ID, full session ID, prefix, or name")
    .addHelpText(
      "after",
      "\nThe last unarchived agent also archives its workspace. Local checkouts are kept; Paseo-owned worktrees are removed, including uncommitted, untracked, ignored, and unpushed work, when no active workspace still references them.\n\nSelf-archive can terminate the invoking shell before a result is printed. Send the handoff first; use an external session for cleanup and verification.",
    );
}

export interface AgentArchiveOptions extends CommandOptions {
  host?: string;
}

export type AgentArchiveCommandResult = SingleResult<AgentArchiveResult>;

export interface AgentArchiveClient extends AgentLookupClient {
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  close(): Promise<void>;
}

export async function runArchiveCommand(
  agentIdArg: string,
  options: AgentArchiveOptions,
  _command: Command,
): Promise<AgentArchiveCommandResult> {
  return archiveAgent(agentIdArg, options);
}

export async function archiveAgent(
  agentIdArg: string,
  options: AgentArchiveOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<AgentArchiveClient> = connectToDaemon,
): Promise<AgentArchiveCommandResult> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent archive <id-or-name>",
    };
    throw error;
  }

  const client = await connect({ target: options.daemonTarget });

  try {
    const agent = await resolveAgentEntry(client, agentIdArg);
    if (!agent) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const agentId = agent.id;

    const result = agent.archivedAt
      ? { archivedAt: agent.archivedAt }
      : await client.archiveAgent(agentId);

    await client.close();

    return {
      type: "single",
      data: {
        agentId,
        status: "archived",
        archivedAt: result.archivedAt,
      },
      schema: archiveSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "ARCHIVE_FAILED",
      message: `Failed to archive agent: ${message}`,
    };
    throw error;
  }
}
