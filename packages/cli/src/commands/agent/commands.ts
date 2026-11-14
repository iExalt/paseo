import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListCommandsResponse } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";

type SlashCommand = ListCommandsResponse["payload"]["commands"][number];
const schema: OutputSchema<SlashCommand> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name" },
    { header: "KIND", field: "kind" },
    { header: "ARGUMENTS", field: "argumentHint" },
    { header: "DESCRIPTION", field: "description" },
  ],
};
type CommandsClient = Pick<DaemonClient, "listCommands" | "fetchAgent" | "close">;
type Connect = (options: ConnectOptions) => Promise<CommandsClient>;
interface Options extends CommandOptions {
  cwd?: string;
  mode?: string;
  model?: string;
  thinking?: string;
}

export async function runAgentCommandsCommand(
  id: string,
  options: CommandOptions,
  _command: Command,
  connect: Connect = connectToDaemon,
): Promise<ListResult<SlashCommand>> {
  const client = await connect({ target: options.daemonTarget });
  try {
    const agentId = await resolveAgentTarget(client, id);
    const response = await client.listCommands({ agentId });
    if (response.error) throw new Error(response.error);
    return { type: "list", data: response.commands, schema };
  } finally {
    await client.close();
  }
}

export async function runProviderCommandsCommand(
  providerInput: string,
  options: Options,
  _command: Command,
  connect: Connect = connectToDaemon,
): Promise<ListResult<SlashCommand>> {
  if (!options.cwd?.trim())
    throw { code: "MISSING_CWD", message: "Pass --cwd with a directory on the selected host." };
  const selected = resolveProviderAndModel({ provider: providerInput, model: options.model });
  const draftConfig: Pick<
    AgentSessionConfig,
    "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId"
  > = {
    provider: selected.provider,
    cwd: options.cwd,
    modeId: options.mode,
    model: selected.model,
    thinkingOptionId: options.thinking,
  };
  const client = await connect({ target: options.daemonTarget });
  try {
    const response = await client.listCommands({ agentId: "__new_agent__", draftConfig });
    if (response.error) throw new Error(response.error);
    return { type: "list", data: response.commands, schema };
  } finally {
    await client.close();
  }
}
