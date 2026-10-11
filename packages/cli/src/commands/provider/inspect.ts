import { Command } from "commander";
import type { ProviderInspectPayload } from "@getpaseo/protocol/messages";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import { parseFeatureValues } from "../../utils/feature-values.js";

export const providerInspectSchema: OutputSchema<ProviderInspectPayload> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 14 },
    { header: "STATUS", field: "status", width: 14 },
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "LABEL", field: (result) => result.label ?? "-", width: 18 },
    { header: "MODEL", field: (result) => result.selectedModel ?? "-", width: 24 },
    {
      header: "MODES",
      field: (result) => (result.modes ?? []).map((mode) => mode.label).join(", "),
    },
  ],
};

export interface ProviderInspectOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  callerAgent?: string;
  mode?: string;
  model?: string;
  thinking?: string;
  feature?: string[];
  featuresJson?: string;
}

export function parseProviderFeatureValues(
  featureFlags: string[] | undefined,
  featuresJson: string | undefined,
): Record<string, unknown> | undefined {
  const parsedFlags = parseFeatureValues(featureFlags);
  if (featuresJson === undefined)
    return Object.keys(parsedFlags).length > 0 ? parsedFlags : undefined;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(featuresJson);
  } catch {
    throw invalidFeaturesJson("--features-json must contain a JSON object.");
  }
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    throw invalidFeaturesJson("--features-json must contain a JSON object.");
  }

  const features = Object.fromEntries(Object.entries(parsedJson));
  const overlap = Object.keys(parsedFlags).find((id) => Object.hasOwn(features, id));
  if (overlap) {
    throw invalidFeaturesJson(`Feature specified more than once: ${overlap}`);
  }
  const combined = { ...features, ...parsedFlags };
  return combined;
}

function invalidFeaturesJson(message: string): CommandError {
  return {
    code: "INVALID_FEATURE",
    message,
    details: "Use a JSON object for arbitrary values and --feature id=value for primitive values.",
  };
}

export async function runProviderInspectCommand(
  provider: string,
  options: ProviderInspectOptions,
  _command: Command,
): Promise<SingleResult<ProviderInspectPayload>> {
  const requestedCallerAgentId = options.callerAgent?.trim();
  const cwd = options.cwd?.trim();
  const featureValues = parseProviderFeatureValues(options.feature, options.featuresJson);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const callerAgentId = requestedCallerAgentId || (await resolveCallerAgentId(client));
    if (!callerAgentId && !cwd) {
      throw {
        code: "MISSING_CWD",
        message: "cwd is required",
        details: "Pass --cwd, or use --caller-agent to inspect from an agent-scoped directory.",
      } satisfies CommandError;
    }
    // COMPAT(providerInspect): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.providerInspect !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support provider inspect.",
        details: "Update the daemon before inspecting provider capabilities.",
      } satisfies CommandError;
    }
    const result = await client.inspectProvider({
      provider,
      ...(cwd ? { cwd } : {}),
      ...(callerAgentId ? { callerAgentId } : {}),
      settings: {
        ...(options.mode !== undefined ? { modeId: options.mode } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.thinking !== undefined ? { thinkingOptionId: options.thinking } : {}),
        ...(featureValues !== undefined ? { features: featureValues } : {}),
      },
    });
    return { type: "single", data: result, schema: providerInspectSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

export function addProviderInspectOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Working directory used to inspect provider capabilities")
    .option("--caller-agent <id>", "Use an agent caller context and its scoped working directory")
    .option("--mode <id>", "Draft mode ID")
    .option("--model <id>", "Draft model ID")
    .option("--thinking <id>", "Draft thinking option ID")
    .option(
      "--feature <id=value>",
      "Draft provider feature (repeatable or comma-separated)",
      collectMultiple,
      [],
    )
    .option("--features-json <object>", "Draft arbitrary provider feature values as a JSON object");
}

export const providerInspectOutput = withOutput(runProviderInspectCommand);
