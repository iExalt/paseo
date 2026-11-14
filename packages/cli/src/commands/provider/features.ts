import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import type { CommandOptions, OutputSchema } from "../../output/index.js";
interface FeatureOptions extends CommandOptions {
  cwd?: string;
  mode?: string;
  model?: string;
  thinking?: string;
}
type Features = Awaited<ReturnType<DaemonClient["listProviderFeatures"]>>;
const schema: OutputSchema<Features> = {
  idField: "provider",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};
export async function runProviderFeaturesCommand(
  providerId: string,
  options: FeatureOptions,
  _command: Command,
  connect: (
    options: ConnectOptions,
  ) => Promise<Pick<DaemonClient, "listProviderFeatures" | "close">> = connectToDaemon,
) {
  const provider = providerId.trim().toLowerCase();
  const cwd = options.cwd?.trim();
  if (!provider || !cwd)
    throw {
      code: "INVALID_OPTIONS",
      message: "A provider and explicit daemon-side --cwd are required.",
    };
  const client = await connect({ target: options.daemonTarget });
  try {
    const data = await client.listProviderFeatures({
      provider,
      cwd,
      modeId: options.mode,
      model: options.model,
      thinkingOptionId: options.thinking,
    });
    if (data.error) throw { code: "PROVIDER_ERROR", message: data.error, details: data };
    return { type: "single" as const, data, schema };
  } finally {
    await client.close();
  }
}
