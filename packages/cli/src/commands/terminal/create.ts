import type { Command } from "commander";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import type { SingleResult } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  workspace?: string;
  cwd?: string;
  name?: string;
}

export async function runCreateCommand(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);
  try {
    const cwd = options.cwd ?? (options.workspace ? undefined : process.cwd());
    const callerAgentId = await resolveCallerAgentId(daemonClient);
    if (callerAgentId) {
      const result = await daemonClient.createTerminal(
        cwd ?? process.cwd(),
        options.name?.trim() || undefined,
        undefined,
        {
          ...(options.workspace !== undefined ? { workspaceId: options.workspace } : {}),
          callerContext: {
            agentId: callerAgentId,
            ...(options.cwd !== undefined ? { requestedCwd: options.cwd } : {}),
          },
        },
      );
      if (result.error || !result.terminal) {
        throw new Error(result.error ?? "The daemon did not create a terminal");
      }
      return {
        type: "single",
        data: {
          id: result.terminal.id,
          name: result.terminal.name ?? "",
          cwd: result.terminal.cwd,
          workspaceId: result.terminal.workspaceId ?? "",
        },
        schema: terminalSchema,
      };
    }
    const workspaceId =
      options.workspace ?? (await client.workspaces.open(options.cwd ?? process.cwd())).id;
    const terminal = await client.terminals.create({
      workspaceId,
      cwd,
      name: options.name?.trim() || undefined,
    });
    const snapshot = terminal.current();
    if (!snapshot) throw new Error("The daemon did not create a terminal");
    return {
      type: "single",
      data: snapshot,
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await close().catch(() => {});
  }
}
