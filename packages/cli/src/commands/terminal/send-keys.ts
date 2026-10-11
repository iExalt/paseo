import type { Command } from "commander";
import { serializeTerminalKeys } from "@getpaseo/client";
import { renderError, toCommandError } from "../../output/render.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";

export interface TerminalSendKeysOptions extends TerminalCommandOptions {
  literal?: boolean;
}

export async function runSendKeysCommand(
  terminalId: string,
  keys: string[],
  options: TerminalSendKeysOptions,
  _command: Command,
): Promise<void> {
  try {
    const payload = await executeSendKeysCommand(terminalId, keys, options);
    if (options.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    }
  } catch (err) {
    const output = renderError(toCommandError(err), {
      format: options.json ? "json" : "table",
      noColor: options.color === false,
    });
    process.stderr.write(output + "\n");
    process.exit(1);
  }
}

async function executeSendKeysCommand(
  terminalId: string,
  keys: string[],
  options: TerminalSendKeysOptions,
): Promise<{ terminalId: string; keysSent: number }> {
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);

  try {
    const resolvedId = await resolveTerminalId(client, terminalId);
    if (!resolvedId) {
      throw {
        code: "TERMINAL_NOT_FOUND",
        message: `No terminal found matching: ${terminalId}`,
        details: "Use `paseo terminal ls --all` to list available terminals.",
      };
    }

    const data = serializeTerminalKeys(keys, options.literal);
    await daemonClient.sendTerminalInputAndWait(resolvedId, data);

    return {
      terminalId: resolvedId,
      keysSent: data.length,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_SEND_KEYS_FAILED", "send terminal keys", err);
  } finally {
    await close().catch(() => {});
  }
}
