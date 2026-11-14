import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export async function runRenameCommand(
  terminalId: string,
  name: string,
  options: TerminalCommandOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);
  try {
    const id = await resolveTerminalId(client, terminalId);
    if (!id) throw new Error(`No terminal found matching: ${terminalId}`);
    const result = await daemonClient.renameTerminal({ terminalId: id, title: name });
    if (!result.success) throw new Error(result.error ?? "Terminal rename failed");
    const terminal = await client.terminals.ref(id).refresh();
    if (!terminal) throw new Error(`Terminal disappeared: ${id}`);
    return { type: "single", data: terminal, schema: terminalSchema };
  } catch (error) {
    throw toTerminalCommandError("TERMINAL_RENAME_FAILED", "rename terminal", error);
  } finally {
    await close().catch(() => {});
  }
}
