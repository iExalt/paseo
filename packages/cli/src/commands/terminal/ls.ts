import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export interface TerminalLsOptions extends TerminalCommandOptions {
  workspace?: string;
  all?: boolean;
  cwd?: string;
}

export async function runLsCommand(
  options: TerminalLsOptions,
  _command: Command,
): Promise<ListResult<TerminalRow>> {
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);
  try {
    const callerAgentId =
      options.all || options.workspace ? undefined : await resolveCallerAgentId(daemonClient);
    let cwd: string | undefined;
    if (!options.all && !options.workspace) {
      cwd = callerAgentId ? options.cwd : (options.cwd ?? process.cwd());
    }
    if (callerAgentId) {
      const payload = await daemonClient.listTerminals(cwd, undefined, {
        callerContext: {
          agentId: callerAgentId,
          ...(options.cwd !== undefined ? { requestedCwd: options.cwd } : {}),
        },
      });
      return {
        type: "list",
        data: payload.terminals.map((terminal) => {
          if (terminal.cwd === undefined) {
            throw new Error(`Terminal ${terminal.id} did not include its working directory`);
          }
          return {
            id: terminal.id,
            name: terminal.name ?? "",
            cwd: terminal.cwd,
            workspaceId: terminal.workspaceId ?? "",
          };
        }),
        schema: terminalSchema,
      };
    }
    const payload = await client.terminals.list({ cwd, workspaceId: options.workspace });
    return {
      type: "list",
      data: payload.entries,
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    await close().catch(() => {});
  }
}
