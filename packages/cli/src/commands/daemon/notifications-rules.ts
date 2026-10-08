import { Command } from "commander";
import { ReplyRuleSchema, type ReplyRule } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import {
  withOutput,
  type AnyCommandResult,
  type CommandError,
  type CommandOptions,
  type OutputOptions,
  type SingleResult,
} from "../../output/index.js";

interface ReplyRulesResult {
  replyRules: ReplyRule[];
}

const replyRulesSchema = {
  idField: () => "replyRules",
  columns: [],
  renderHuman: (commandResult: AnyCommandResult<ReplyRulesResult>, _options: OutputOptions) =>
    JSON.stringify(commandResult.data, null, 2),
};

function result(replyRules: ReplyRule[]): SingleResult<ReplyRulesResult> {
  return {
    type: "single" as const,
    data: { replyRules },
    schema: replyRulesSchema,
  };
}

export async function runGetNotificationRulesCommand(
  options: CommandOptions,
): Promise<SingleResult<ReplyRulesResult>> {
  const response = await withDaemon(
    options,
    (client) => client.getDaemonNotificationRules(),
    "REPLY_RULES_GET_FAILED",
  );
  return result(response.replyRules);
}

export async function runSetNotificationRulesCommand(
  raw: string,
  options: CommandOptions,
): Promise<SingleResult<ReplyRulesResult>> {
  const replyRules = parseReplyRules(raw);
  const response = await withDaemon(
    options,
    (client) => client.setDaemonNotificationRules(replyRules),
    "REPLY_RULES_SET_FAILED",
  );
  return result(response.replyRules);
}

export async function runClearNotificationRulesCommand(
  options: CommandOptions,
): Promise<SingleResult<ReplyRulesResult>> {
  const response = await withDaemon(
    options,
    (client) => client.setDaemonNotificationRules([]),
    "REPLY_RULES_CLEAR_FAILED",
  );
  return result(response.replyRules);
}

function parseReplyRules(raw: string): ReplyRule[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_REPLY_RULES_JSON",
      message: "Reply rules must be a valid JSON array.",
      details: message,
    } satisfies CommandError;
  }
  try {
    return z.array(ReplyRuleSchema).parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_REPLY_RULES_JSON",
      message: "Reply rules must be an array of objects with source and flags strings.",
      details: message,
    } satisfies CommandError;
  }
}

async function withDaemon<T>(
  options: CommandOptions,
  operation: (client: Awaited<ReturnType<typeof connectToDaemon>>) => Promise<T>,
  failureCode: string,
): Promise<T> {
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon: ${message}`,
      details: "Start the daemon or choose an available --host.",
    } satisfies CommandError;
  });
  try {
    return await operation(client);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Update the host to manage daemon-wide notification rules.")) {
      throw { code: "DAEMON_UPDATE_REQUIRED", message } satisfies CommandError;
    }
    throw { code: failureCode, message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function daemonNotificationRulesCommand(): Command {
  const notifications = new Command("notifications").description(
    "Manage daemon-wide reply notification rules",
  );
  const rules = notifications.command("rules").description("Manage reply filtering rules");

  addJsonAndDaemonHostOptions(
    rules.command("get").description("Read the current reply rules"),
  ).action(
    withOutput(async (_options: CommandOptions, _command: Command) => {
      return runGetNotificationRulesCommand(_options);
    }),
  );

  addJsonAndDaemonHostOptions(
    rules
      .command("set <rules-json>")
      .description(
        'Replace all reply rules with a JSON array. Example: paseo daemon notifications rules set \'[{"source":"^No news\\\\.$","flags":"u"}]\'',
      ),
  ).action(
    withOutput(async (raw: string, options: CommandOptions, _command: Command) => {
      return runSetNotificationRulesCommand(raw, options);
    }),
  );

  addJsonAndDaemonHostOptions(
    rules.command("clear").description("Remove all reply filtering rules"),
  ).action(
    withOutput(async (options: CommandOptions, _command: Command) => {
      return runClearNotificationRulesCommand(options);
    }),
  );

  return notifications;
}
