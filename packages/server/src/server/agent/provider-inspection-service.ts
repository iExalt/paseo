import {
  ProviderInspectResultSchema,
  type ProviderInspectRequest,
  type ProviderInspectPayload,
} from "@getpaseo/protocol/messages";
import type { AgentFeature, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentManager } from "./agent-manager.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import type { VoiceCallerContext } from "../voice-types.js";
import { resolveScopedAgentCwd } from "./scoped-cwd.js";
import { resolveScheduleProviderAndModel } from "./mcp-shared.js";

export type ProviderInspectionInput = Omit<ProviderInspectRequest, "type" | "requestId">;

interface DraftFeatureConfigOptions {
  input: ProviderInspectionInput;
  provider: string;
  cwd: string;
  model: string | undefined;
}

interface ProviderInspectionOptions {
  input: ProviderInspectionInput;
  agentManager: AgentManager;
  providerSnapshotManager: ProviderSnapshotManager;
  resolveCallerContext?: (agentId: string) => VoiceCallerContext | null;
}

function createDraftFeatureConfig(options: DraftFeatureConfigOptions): AgentSessionConfig {
  const { input, provider, cwd, model } = options;
  return {
    provider,
    cwd,
    ...(input.settings?.modeId ? { modeId: input.settings.modeId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(input.settings?.thinkingOptionId
      ? { thinkingOptionId: input.settings.thinkingOptionId }
      : {}),
    ...(input.settings?.features ? { featureValues: input.settings.features } : {}),
  };
}

export async function inspectProviderCapabilities(
  params: ProviderInspectionOptions,
): Promise<Omit<ProviderInspectPayload, "requestId">> {
  const { input, agentManager, providerSnapshotManager } = params;
  const resolved = resolveScheduleProviderAndModel({
    provider: input.provider,
    defaultProvider: input.provider,
  });
  const callerAgent = input.callerAgentId ? agentManager.getAgent(input.callerAgentId) : null;
  if (input.callerAgentId && !callerAgent) {
    throw new Error(`Parent agent ${input.callerAgentId} not found`);
  }
  const callerContext = input.callerAgentId
    ? (params.resolveCallerContext?.(input.callerAgentId) ?? null)
    : null;
  const cwd = resolveScopedAgentCwd({
    requestedCwd: input.cwd,
    callerAgent,
    callerContext,
    required: true,
  });
  const entry = await providerSnapshotManager.getProvider({
    cwd,
    provider: resolved.provider,
    wait: true,
  });
  const summary = {
    enabled: entry.enabled,
    label: entry.label ?? resolved.provider,
    description: entry.description ?? "",
    status: entry.status === "ready" ? "available" : entry.status,
    modes: entry.modes ?? [],
  };
  if (!entry.enabled) throw new Error(`Provider '${resolved.provider}' is disabled`);
  if (entry.status !== "ready") {
    throw new Error(entry.error ?? `Provider '${resolved.provider}' is unavailable`);
  }

  const selectedModel = input.settings?.model ?? resolved.model;
  const features: AgentFeature[] = await agentManager.listDraftFeatures(
    createDraftFeatureConfig({ input, provider: resolved.provider, cwd, model: selectedModel }),
  );

  return ProviderInspectResultSchema.parse({
    provider: resolved.provider,
    label: summary.label,
    description: summary.description,
    enabled: summary.enabled,
    status: summary.status,
    modes: summary.modes,
    selectedModel: selectedModel ?? null,
    features,
  });
}
