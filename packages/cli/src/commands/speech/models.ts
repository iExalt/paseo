import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { LocalSpeechModel } from "@getpaseo/protocol/speech/rpc-schemas";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";

interface ModelResult {
  action: "download_requested" | "removed";
  modelId: string;
}
interface ModelListResult {
  models: LocalSpeechModel[];
}
type ModelsClient = Pick<
  DaemonClient,
  | "getLastServerInfoMessage"
  | "listLocalSpeechModels"
  | "downloadLocalSpeechModel"
  | "deleteLocalSpeechModel"
  | "close"
>;
const schema: OutputSchema<ModelResult> = {
  idField: () => "models",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};

export function speechModelsCommand(): Command {
  const models = new Command("models").description("Manage local speech models on the host");
  addJsonAndDaemonHostOptions(
    models.command("ls").description("List available models and download state"),
  ).action(
    withOutput((options: CommandOptions, command: Command) =>
      runSpeechModelsListCommand(options, command),
    ),
  );
  for (const action of ["download", "rm"] as const) {
    addJsonAndDaemonHostOptions(
      models.command(action).argument("<model-id>", "Exact model ID"),
    ).action(
      withOutput((modelId: string, options: CommandOptions, command: Command) =>
        runSpeechModelsCommand(action, modelId, options, command),
      ),
    );
  }
  return models;
}

export async function runSpeechModelsCommand(
  action: "download" | "rm",
  modelId: string,
  options: CommandOptions,
  _command: Command,
  connect: (options: ConnectOptions) => Promise<ModelsClient> = connectToDaemon,
): Promise<SingleResult<ModelResult>> {
  const id = modelId.trim();
  if (!id) throw { code: "INVALID_MODEL", message: "A nonempty model ID is required." };
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.speechSettings !== true)
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to manage speech models." };
    if (action === "download") {
      await client.downloadLocalSpeechModel(id);
      return { type: "single", data: { action: "download_requested", modelId: id }, schema };
    }
    await client.deleteLocalSpeechModel(id);
    return { type: "single", data: { action: "removed", modelId: id }, schema };
  } finally {
    await client.close();
  }
}

const listSchema: OutputSchema<ModelListResult> = {
  idField: () => "models",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};
export async function runSpeechModelsListCommand(
  options: CommandOptions,
  _command: Command,
  connect: (options: ConnectOptions) => Promise<ModelsClient> = connectToDaemon,
): Promise<SingleResult<ModelListResult>> {
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.speechSettings !== true)
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to manage speech models." };
    return {
      type: "single",
      data: { models: await client.listLocalSpeechModels() },
      schema: listSchema,
    };
  } finally {
    await client.close();
  }
}
