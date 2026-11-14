import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentProfileSchema,
  assertRemoteProfileFeatures,
  type AgentProfile,
} from "@getpaseo/protocol/agent-profile";
import type { AgentConfigApply } from "@getpaseo/protocol/messages";
import { parseFeatureValues } from "./feature-values.js";
import { resolveProviderAndModel } from "./provider-model.js";

export async function readAgentProfile(
  client: Pick<DaemonClient, "getLastServerInfoMessage" | "listAgentProfiles">,
  id: string,
): Promise<AgentProfile> {
  if (client.getLastServerInfoMessage()?.features?.profileList !== true)
    throw new Error("Update the host to use saved profiles");
  const { profiles } = await client.listAgentProfiles();
  const found = profiles.find((profile) => profile.id === id);
  if (!found) throw new Error(`Unknown profile: ${id}`);
  const profile = AgentProfileSchema.parse(found);
  assertRemoteProfileFeatures(profile.featureValues);
  return profile;
}

export function profileConfig(profile: AgentProfile): AgentConfigApply {
  return {
    ...(profile.model?.trim() ? { modelId: profile.model.trim() } : {}),
    ...(profile.modeId?.trim() ? { modeId: profile.modeId.trim() } : {}),
    ...(profile.thinkingOptionId?.trim()
      ? { thinkingOptionId: profile.thinkingOptionId.trim() }
      : {}),
    ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
  };
}

interface RunProfileOptions {
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  feature?: string[];
  featuresJson?: string;
}
export function withProfileDefaults<T extends RunProfileOptions>(
  options: T,
  profile: AgentProfile,
): T {
  const explicit = options.provider ? resolveProviderAndModel(options) : undefined;
  if (explicit && explicit.provider !== profile.provider)
    throw new Error("--provider must match the selected profile's provider");
  const features = {
    ...profile.featureValues,
    ...parseFeatureValues(options.feature, options.featuresJson),
  };
  return {
    ...options,
    provider: explicit?.provider ?? profile.provider,
    model: explicit?.model ?? options.model ?? (profile.model?.trim() || undefined),
    mode: options.mode ?? (profile.modeId?.trim() || undefined),
    thinking: options.thinking ?? (profile.thinkingOptionId?.trim() || undefined),
    feature: [],
    featuresJson: JSON.stringify(features),
  };
}
