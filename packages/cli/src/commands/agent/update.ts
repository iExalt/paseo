import type { Command } from "commander";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { parseFeatureValues } from "../../utils/feature-values.js";

/** Result type for agent update command */
export interface AgentUpdateResult {
  agentId: string;
  name: string | null;
  labels: string;
  thinkingOptionId: string | null;
  noticeType: AgentProviderNotice["type"] | null;
  notice: string | null;
  notices: AgentProviderNotice[];
}

/** Schema for update command output */
export const updateSchema: OutputSchema<AgentUpdateResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "NAME", field: "name" },
    { header: "LABELS", field: "labels" },
    { header: "THINKING", field: "thinkingOptionId" },
    { header: "NOTICE", field: "notice" },
    {
      header: "NOTICES",
      field: (result) => result.notices.map((notice) => notice.message).join("; "),
    },
  ],
};

export interface AgentUpdateOptions extends CommandOptions {
  name?: string;
  label?: string[];
  mode?: string;
  model?: string;
  clearModel?: boolean;
  thinking?: string;
  clearThinking?: boolean;
  feature?: string[];
  featuresJson?: string;
  host?: string;
}

export type AgentUpdateCommandResult = SingleResult<AgentUpdateResult>;

export interface AgentMetadataChanges {
  name?: string;
  labels?: Record<string, string>;
}

interface AgentUpdateServerInfo {
  features?: { agentThinkingUpdate?: boolean };
}

export interface AgentUpdateClient {
  getLastServerInfoMessage(): AgentUpdateServerInfo | null;
  updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void>;
  setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  setAgentModel(agentId: string, modelId: string | null): Promise<void>;
  setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null>;
  setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void>;
}

export interface AgentChanges {
  modeId?: string;
  modelId?: string | null;
  thinkingOptionId?: string | null;
  features?: Record<string, unknown>;
  metadata?: AgentMetadataChanges;
}

export interface AppliedAgentChanges {
  notice: AgentProviderNotice | null;
  notices: AgentProviderNotice[];
}

export function toAgentUpdateResult(
  agent: Pick<AgentSnapshotPayload, "id" | "title" | "labels" | "effectiveThinkingOptionId">,
  appliedChanges: AppliedAgentChanges,
): AgentUpdateResult {
  return {
    agentId: agent.id,
    name: agent.title,
    labels: formatLabels(agent.labels),
    thinkingOptionId: agent.effectiveThinkingOptionId ?? null,
    noticeType: appliedChanges.notice?.type ?? null,
    notice: appliedChanges.notice?.message ?? null,
    notices: appliedChanges.notices,
  };
}

export async function applyAgentChanges(
  client: AgentUpdateClient,
  agentId: string,
  changes: AgentChanges,
): Promise<AppliedAgentChanges> {
  if (
    changes.thinkingOptionId !== undefined &&
    client.getLastServerInfoMessage()?.features?.agentThinkingUpdate !== true
  ) {
    // COMPAT(agentThinkingUpdate): added in v0.2.4, remove gate after 2027-01-28.
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use agent thinking updates.",
    } satisfies CommandError;
  }

  const steps = createAgentUpdateSteps(client, agentId, changes);
  let notice: AgentProviderNotice | null = null;
  const notices: AgentProviderNotice[] = [];
  const completedSteps: string[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      const stepNotice = await step.apply();
      if (stepNotice) {
        notice ??= stepNotice;
        notices.push(stepNotice);
      }
      completedSteps.push(step.name);
    } catch (error) {
      throw createPartialUpdateError(error, step.name, completedSteps, steps.slice(index + 1));
    }
  }
  return { notice, notices };
}

interface AgentUpdateStep {
  name: string;
  apply: () => Promise<AgentProviderNotice | null>;
}

function createAgentUpdateSteps(
  client: AgentUpdateClient,
  agentId: string,
  changes: AgentChanges,
): AgentUpdateStep[] {
  const steps: AgentUpdateStep[] = [];
  if (changes.modeId !== undefined) {
    const modeId = changes.modeId;
    steps.push({ name: "mode", apply: () => client.setAgentMode(agentId, modeId) });
  }
  if (changes.modelId !== undefined) {
    const modelId = changes.modelId;
    steps.push({
      name: "model",
      apply: async () => {
        await client.setAgentModel(agentId, modelId);
        return null;
      },
    });
  }
  if (changes.thinkingOptionId !== undefined) {
    const thinkingOptionId = changes.thinkingOptionId;
    steps.push({
      name: "thinking",
      apply: () => client.setAgentThinkingOption(agentId, thinkingOptionId),
    });
  }
  for (const [featureId, value] of Object.entries(changes.features ?? {})) {
    steps.push({
      name: `feature ${featureId}`,
      apply: async () => {
        await client.setAgentFeature(agentId, featureId, value);
        return null;
      },
    });
  }
  if (changes.metadata) {
    const metadata = changes.metadata;
    steps.push({
      name: "metadata",
      apply: async () => {
        await client.updateAgent(agentId, metadata);
        return null;
      },
    });
  }
  return steps;
}

function createPartialUpdateError(
  error: unknown,
  failedStep: string,
  completedSteps: string[],
  unattemptedSteps: AgentUpdateStep[],
): CommandError {
  const source = error && typeof error === "object" ? error : null;
  const sourceCode =
    source && "code" in source && typeof source.code === "string" ? source.code : undefined;
  let sourceMessage = String(error);
  if (error instanceof Error) {
    sourceMessage = error.message;
  } else if (source && "message" in source && typeof source.message === "string") {
    sourceMessage = source.message;
  }
  const completed = completedSteps.length > 0 ? completedSteps.join(", ") : "none";
  const unattempted =
    unattemptedSteps.length > 0 ? unattemptedSteps.map((step) => step.name).join(", ") : "none";
  return {
    code: sourceCode ?? "UPDATE_FAILED",
    message: sourceMessage,
    details: `Failed step: ${failedStep}. Completed before failure: ${completed}. Not attempted: ${unattempted}. Earlier accepted changes may remain; the failed step's outcome may be unknown if its response was lost.`,
  };
}

function parseLabelOptions(labels: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!labels) {
    return parsed;
  }

  for (const rawLabel of labels) {
    for (const segment of rawLabel.split(",")) {
      const label = segment.trim();
      if (!label) {
        continue;
      }

      const eqIndex = label.indexOf("=");
      if (eqIndex === -1) {
        const error: CommandError = {
          code: "INVALID_LABEL",
          message: `Invalid label format: ${label}`,
          details: "Labels must be in key=value format",
        };
        throw error;
      }

      const key = label.slice(0, eqIndex).trim();
      const value = label.slice(eqIndex + 1);
      if (!key) {
        const error: CommandError = {
          code: "INVALID_LABEL",
          message: `Invalid label format: ${label}`,
          details: "Labels must include a non-empty key in key=value format",
        };
        throw error;
      }

      parsed[key] = value;
    }
  }

  return parsed;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

export function parseAgentChanges(options: AgentUpdateOptions): AgentChanges {
  const name = options.name?.trim();
  if (options.name !== undefined && !name) {
    throw {
      code: "INVALID_NAME",
      message: "Name cannot be empty",
      details: "Use --name <name> with a non-empty value",
    } satisfies CommandError;
  }

  const labels = parseLabelOptions(options.label);
  const modeId = parseOptionalId(
    options.mode,
    "--mode",
    "INVALID_MODE",
    "Provide a provider mode ID.",
  );
  const modelId = parseOptionalId(
    options.model,
    "--model",
    "INVALID_MODEL",
    "Provide a model ID or use --clear-model.",
  );
  if (options.clearModel && options.model !== undefined) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--clear-model cannot be combined with --model",
    };
  }
  const thinkingOptionId = parseOptionalId(
    options.thinking,
    "--thinking",
    "INVALID_THINKING_OPTION",
    'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
  );

  if (options.clearThinking && options.thinking !== undefined) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--clear-thinking cannot be combined with --thinking",
    };
  }

  const features = parseFeatureValues(options.feature, options.featuresJson);
  const metadata: AgentMetadataChanges = {
    ...(name ? { name } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
  const hasMetadataUpdates = Object.keys(metadata).length > 0;

  const changes: AgentChanges = {};
  if (modeId !== undefined) changes.modeId = modeId;
  if (options.clearModel) {
    changes.modelId = null;
  } else if (modelId !== undefined) {
    changes.modelId = modelId;
  }
  if (options.clearThinking) {
    changes.thinkingOptionId = null;
  } else if (thinkingOptionId !== undefined) {
    changes.thinkingOptionId = thinkingOptionId;
  }
  if (Object.keys(features).length > 0) changes.features = features;
  if (hasMetadataUpdates) changes.metadata = metadata;
  if (Object.keys(changes).length === 0) {
    throw {
      code: "NO_CHANGES_PROVIDED",
      message: "Nothing to update",
      details: "Provide at least one runtime setting, feature, --name, or --label change.",
    } satisfies CommandError;
  }
  return changes;
}

function parseOptionalId(
  value: string | undefined,
  flagName: string,
  code: CommandError["code"],
  details: string,
): string | undefined {
  const parsed = value?.trim();
  if (value !== undefined && !parsed) {
    throw {
      code,
      message: `${flagName} cannot be empty`,
      details,
    } satisfies CommandError;
  }
  return parsed;
}

export async function runUpdateCommand(
  agentIdArg: string,
  options: AgentUpdateOptions,
  _command: Command,
): Promise<AgentUpdateCommandResult> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details:
        "Usage: paseo agent update <id> [runtime settings] [--name <name>] [--label <key=value>]",
    };
    throw error;
  }

  const changes = parseAgentChanges(options);

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const fetchResult = await client.fetchAgent({ agentId: agentIdArg });
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const agentId = fetchResult.agent.id;

    const appliedChanges = await applyAgentChanges(client, agentId, changes);

    const updatedResult = await client.fetchAgent({ agentId });
    if (!updatedResult) {
      throw new Error(`Agent not found after update: ${agentId}`);
    }

    await client.close();

    return {
      type: "single",
      data: toAgentUpdateResult(updatedResult.agent, appliedChanges),
      schema: updateSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "UPDATE_FAILED",
      message: `Failed to update agent: ${message}`,
    };
    throw error;
  }
}
