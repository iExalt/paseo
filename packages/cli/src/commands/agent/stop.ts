import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { isSameOrDescendantPath } from "../../utils/paths.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent stop command */
export interface StopResult {
  stoppedCount: number;
  agentIds: string[];
  success?: boolean;
  results?: StopTargetResult[];
}

export interface StopTargetResult {
  agentId: string;
  cancelled?: boolean;
  error?: string;
}

/** Schema for stop command output */
export const stopSchema: OutputSchema<StopResult> = {
  // For quiet mode, output the stopped agent IDs (one per line)
  idField: (item) => item.agentIds.join("\n"),
  columns: [{ header: "INTERRUPTED", field: "stoppedCount" }],
};

export function addStopOptions(cmd: Command): Command {
  return cmd
    .description("Interrupt an agent if it is running (no-op for idle agents)")
    .argument("[id]", "Agent ID (or prefix) - optional if --all or --cwd specified")
    .option("--all", "Stop all agents")
    .option("--cwd <path>", "Stop all agents in directory");
}

export interface AgentStopOptions extends CommandOptions {
  all?: boolean;
  cwd?: string;
}

export type AgentStopResult = SingleResult<StopResult>;

async function cancelStopTarget(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  agentId: string,
) {
  try {
    const cancelled = await client.cancelAgent(agentId);
    if (typeof cancelled !== "boolean") {
      throw new Error("Daemon did not report whether the agent run was cancelled");
    }
    return { ok: true as const, id: agentId, cancelled };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, id: agentId, message };
  }
}

function collectStopResults(
  stopResults: Awaited<ReturnType<typeof cancelStopTarget>>[],
  singleTarget: boolean,
): StopResult {
  const agentIds: string[] = [];
  const results: StopTargetResult[] = [];
  for (const result of stopResults) {
    if (!result.ok) {
      if (singleTarget) {
        throw {
          code: "STOP_AGENT_FAILED",
          message: `Failed to stop agent ${result.id}: ${result.message}`,
        } satisfies CommandError;
      }
      console.error(`Warning: Failed to stop agent ${result.id.slice(0, 7)}: ${result.message}`);
      results.push({ agentId: result.id, error: result.message });
      continue;
    }
    results.push({ agentId: result.id, cancelled: result.cancelled });
    if (result.cancelled) agentIds.push(result.id);
  }
  return {
    stoppedCount: agentIds.length,
    agentIds,
    ...(singleTarget && results[0]?.cancelled !== undefined
      ? { success: results[0].cancelled }
      : {}),
    ...(singleTarget ? {} : { results }),
  };
}

export async function runStopCommand(
  id: string | undefined,
  options: AgentStopOptions,
  _command: Command,
): Promise<AgentStopResult> {
  // Validate arguments - need either an id, --all, or --cwd
  if (!id && !options.all && !options.cwd) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Agent ID required unless --all or --cwd is specified",
      details: "Usage: paseo agent stop <id> | --all | --cwd <path>",
    };
    throw error;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // COMPAT(agentCancelOutcome): added in v0.11.2; remove gate after 2027-04-10.
    if (client.getLastServerInfoMessage()?.features?.agentCancelOutcome !== true) {
      throw {
        code: "UNSUPPORTED_DAEMON_FEATURE",
        message: "Agent stop requires a daemon that reports cancellation outcomes.",
        details: "Update the daemon and try again.",
      } satisfies CommandError;
    }

    const fetchPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    let agents = fetchPayload.entries.map((entry) => entry.agent);

    if (options.all) {
      // Stop all agents (not archived)
      agents = agents.filter((a) => !a.archivedAt);
    } else if (options.cwd) {
      // Stop agents in directory
      agents = agents.filter((a) => {
        if (a.archivedAt) return false;
        return isSameOrDescendantPath(options.cwd!, a.cwd);
      });
    } else if (id) {
      // Stop specific agent
      const fetchResult = await client.fetchAgent({ agentId: id });
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

    // Interrupt each running agent. Idle agents are a no-op.
    const stopResults = await Promise.all(
      agents.map((agent) => cancelStopTarget(client, agent.id)),
    );
    const singleTarget = Boolean(id && !options.all && !options.cwd);
    const data = collectStopResults(stopResults, singleTarget);

    await client.close();

    return {
      type: "single",
      data,
      schema: stopSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    // Re-throw if it's already a CommandError
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "STOP_AGENT_FAILED",
      message: `Failed to stop agent(s): ${message}`,
    };
    throw error;
  }
}
