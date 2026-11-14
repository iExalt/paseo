import {
  resolveTerminalProfiles,
  resolveTerminalProfileLaunch,
} from "@getpaseo/protocol/terminal-profiles";
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
  command?: string;
  arg?: string[];
  profile?: string;
  rows?: number;
  cols?: number;
}

export async function runCreateCommand(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);
  try {
    const { name, command, args, size } = await resolveLaunch(options, daemonClient);
    const cwd = options.cwd ?? (options.workspace ? undefined : process.cwd());
    const callerAgentId = await resolveCallerAgentId(daemonClient);
    if (callerAgentId) {
      const result = await daemonClient.createTerminal(cwd ?? process.cwd(), name, undefined, {
        ...(options.workspace !== undefined ? { workspaceId: options.workspace } : {}),
        command,
        args,
        size,
        callerContext: {
          agentId: callerAgentId,
          ...(options.cwd !== undefined ? { requestedCwd: options.cwd } : {}),
        },
      });
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
          title: result.terminal.title,
          activity: result.terminal.activity,
        },
        schema: terminalSchema,
      };
    }
    const workspaceId =
      options.workspace ?? (await client.workspaces.open(options.cwd ?? process.cwd())).id;
    const terminal = await client.terminals.create({
      workspaceId,
      cwd,
      name,
      command,
      args,
      size,
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

async function resolveLaunch(
  options: TerminalCreateOptions,
  daemonClient: Awaited<ReturnType<typeof connectTerminalClient>>["daemonClient"],
) {
  let name = options.name?.trim() || undefined;
  let command = options.command;
  let args = options.arg;
  if (options.profile !== undefined) {
    const { config } = await daemonClient.getDaemonConfig();
    const profile = resolveTerminalProfiles(config.terminalProfiles).find(
      (entry) => entry.id === options.profile,
    );
    if (!profile) throw new Error(`Terminal profile not found: ${options.profile}`);
    const launch = resolveTerminalProfileLaunch(profile, "");
    name ??= launch.name;
    command = launch.command;
    args = launch.args;
  }
  const size =
    options.rows !== undefined || options.cols !== undefined
      ? { rows: options.rows ?? 24, cols: options.cols ?? 80 }
      : undefined;
  return { name, command, args, size };
}
