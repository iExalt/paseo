import type { AgentManager } from "../agent/agent-manager.js";
import { AgentProviderEnum, resolveScheduleProviderAndModel } from "../agent/mcp-shared.js";
import { expandUserPath } from "../path-utils.js";
import type { ScheduleTarget } from "@getpaseo/protocol/schedule/types";

export interface CallerScheduleOverrides {
  provider?: string;
  model?: string;
  cwd?: string;
  modeId?: string;
  thinkingOptionId?: string;
  isolation?: "local" | "worktree";
}

interface ResolveScheduleTargetInput {
  callerAgent?: ReturnType<AgentManager["getAgent"]> | null;
  overrides?: CallerScheduleOverrides;
  defaultCwd?: string;
}

interface ResolvedScheduleConfig {
  provider: string;
  model?: string;
  modeId?: string;
  cwd: string;
  callerAgent?: ReturnType<AgentManager["getAgent"]> | null;
  overrides: CallerScheduleOverrides;
}

interface ResolvedProviderModel {
  provider: string;
  model?: string;
}

function resolveProviderModel(
  callerAgent: ReturnType<AgentManager["getAgent"]> | null | undefined,
  overrides: CallerScheduleOverrides,
): ResolvedProviderModel {
  if (!callerAgent && !overrides.provider?.trim()) {
    throw new Error("provider is required when target is new-agent");
  }
  const defaultProvider =
    callerAgent?.provider ?? AgentProviderEnum.parse(overrides.provider?.split("/")[0]?.trim());
  const providerWasOverridden = overrides.provider !== undefined;
  const resolvedProviderModel = resolveScheduleProviderAndModel({
    provider: overrides.provider,
    defaultProvider,
  });
  if (
    resolvedProviderModel.model &&
    overrides.model &&
    resolvedProviderModel.model !== overrides.model
  ) {
    throw new Error("Conflicting model values provided");
  }
  const provider = resolvedProviderModel.provider;
  const model =
    overrides.model ??
    resolvedProviderModel.model ??
    (!providerWasOverridden ? callerAgent?.config.model : undefined);
  return { provider, ...(model ? { model } : {}) };
}

function resolveConfigFields(
  callerAgent: ReturnType<AgentManager["getAgent"]> | null | undefined,
  overrides: CallerScheduleOverrides,
  defaultCwd: string,
): ResolvedScheduleConfig {
  const { provider, model } = resolveProviderModel(callerAgent, overrides);
  const modeId =
    overrides.modeId ??
    (callerAgent?.provider === provider ? (callerAgent.currentModeId ?? undefined) : undefined);

  return {
    provider,
    ...(model ? { model } : {}),
    ...(modeId ? { modeId } : {}),
    cwd: overrides.cwd?.trim() ? expandUserPath(overrides.cwd) : (callerAgent?.cwd ?? defaultCwd),
    callerAgent,
    overrides,
  };
}

function buildScheduleConfig(
  resolved: ResolvedScheduleConfig,
): Extract<ScheduleTarget, { type: "new-agent" }>["config"] {
  const { callerAgent, overrides, provider, model, modeId, cwd } = resolved;
  const config: Extract<ScheduleTarget, { type: "new-agent" }>["config"] = { provider, cwd };
  const thinkingOptionId = overrides.thinkingOptionId ?? callerAgent?.config.thinkingOptionId;
  if (model) config.model = model;
  if (modeId) config.modeId = modeId;
  if (thinkingOptionId) config.thinkingOptionId = thinkingOptionId;
  if (overrides.isolation) config.isolation = overrides.isolation;
  if (callerAgent?.provider === provider && callerAgent.config.providerOptions) {
    config.providerOptions = callerAgent.config.providerOptions;
  }
  if (callerAgent?.config.featureValues) config.featureValues = callerAgent.config.featureValues;
  if (callerAgent?.config.systemPrompt) config.systemPrompt = callerAgent.config.systemPrompt;
  if (callerAgent?.config.mcpServers) config.mcpServers = callerAgent.config.mcpServers;
  return config;
}

export function resolveNewAgentScheduleTarget(
  input: ResolveScheduleTargetInput,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const { callerAgent, overrides = {}, defaultCwd = process.cwd() } = input;
  return {
    type: "new-agent",
    config: buildScheduleConfig(resolveConfigFields(callerAgent, overrides, defaultCwd)),
  };
}
