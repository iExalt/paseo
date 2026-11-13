import type { Command } from "commander";
import { renderTable } from "../../output/index.js";
import { getErrorMessage } from "../../utils/errors.js";
import { connectToDaemon } from "../../utils/client.js";
import { isSameOrDescendantPath } from "../../utils/paths.js";
import type { DaemonClient, FetchAgentHistoryEntry } from "@getpaseo/client/internal/daemon-client";

export function addDeleteOptions(cmd: Command): Command {
  return cmd
    .description("Delete an agent; archive its workspace when no unarchived agents remain")
    .argument("[id]", "Agent ID, prefix, or full session ID - optional if --all or --cwd specified")
    .option("--all", "Delete all agents")
    .option("--cwd <path>", "Delete all agents in directory");
}
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface DeleteResult {
  deletedCount: number;
  agentIds: string[];
  results?: { agentId: string; deleted?: boolean; error?: string }[];
}

export const deleteSchema: OutputSchema<DeleteResult> = {
  idField: (item) => item.agentIds.join("\n"),
  columns: [{ header: "DELETED", field: "deletedCount" }],
  renderHuman: (result, options) => {
    const errors =
      result.type === "single"
        ? (result.data.results ?? []).filter((target) => target.error !== undefined)
        : [];
    return [
      renderTable(result, options),
      ...errors.map((target) => `Failed to delete agent ${target.agentId}: ${target.error}`),
    ].join("\n");
  },
};

export interface AgentDeleteOptions extends CommandOptions {
  all?: boolean;
  cwd?: string;
}

export type AgentDeleteResult = SingleResult<DeleteResult>;

// History includes archived agents and agents whose provider is unavailable.
async function fetchHistoryAgents(client: DaemonClient) {
  const agents: FetchAgentHistoryEntry["agent"][] = [];
  let cursor: string | undefined;
  do {
    const payload = await client.fetchAgentHistory({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...payload.entries.map((entry) => entry.agent));
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

export async function runDeleteCommand(
  id: string | undefined,
  options: AgentDeleteOptions,
  _command: Command,
): Promise<AgentDeleteResult> {
  if (!id && !options.all && !options.cwd) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Agent ID required unless --all or --cwd is specified",
      details: "Usage: paseo agent delete <id> | --all | --cwd <path>",
    };
    throw error;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const deletedIds: string[] = [];
    let agents: FetchAgentHistoryEntry["agent"][];

    if (options.all || options.cwd) {
      agents = await fetchHistoryAgents(client);
      if (!options.all) {
        agents = agents.filter((a) => isSameOrDescendantPath(options.cwd!, a.cwd));
      }
    } else {
      const fetchResult = await client.fetchAgent({ agentId: id! });
      if (!fetchResult) {
        const error: CommandError = {
          code: "AGENT_NOT_FOUND",
          message: `No agent found matching: ${id}`,
          details: "Use `paseo ls` to list available agents",
        };
        throw error;
      }
      agents = [fetchResult.agent];
    }

    const singleTarget = Boolean(id && !options.all && !options.cwd);
    const deleteResults = await Promise.all(
      agents.map(async (agent) => {
        try {
          if (agent.status === "running") {
            await client.cancelAgent(agent.id).catch(() => {});
          }
          await client.deleteAgent(agent.id);
          return { ok: true as const, id: agent.id };
        } catch (err) {
          if (singleTarget) throw err;
          const message = getErrorMessage(err);
          return { ok: false as const, id: agent.id, message };
        }
      }),
    );
    for (const result of deleteResults) {
      if (result.ok) {
        deletedIds.push(result.id);
      } else {
        process.exitCode = 1;
      }
    }

    await client.close();

    return {
      type: "single",
      data: {
        deletedCount: deletedIds.length,
        agentIds: deletedIds,
        ...(singleTarget
          ? {}
          : {
              results: deleteResults.map((result) =>
                result.ok
                  ? { agentId: result.id, deleted: true }
                  : { agentId: result.id, error: result.message },
              ),
            }),
      },
      schema: deleteSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DELETE_AGENT_FAILED",
      message: `Failed to delete agent(s): ${message}`,
    };
    throw error;
  }
}
