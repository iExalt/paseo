import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { parseFeatureValues } from "../../utils/feature-values.js";
import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentRunOptions } from "./run.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";

export async function prepareAgentFork(
  client: DaemonClient,
  options: AgentRunOptions,
): Promise<CreateAgentRequestOptions["attachments"]> {
  const source = options.forkSource;
  if (!source) return undefined;
  if (client.getLastServerInfoMessage()?.features?.agentForkContext !== true) {
    throw {
      code: "UNSUPPORTED_FEATURE",
      message: "Update the daemon to fork agent conversations.",
    };
  }
  const agentId = await resolveAgentTarget(client, source.agentId);
  const snapshot = await client.fetchAgent({ agentId });
  if (!snapshot) throw { code: "AGENT_NOT_FOUND", message: "Fork source is unavailable." };
  const agent = snapshot.agent;
  const selected = resolveProviderAndModel({ ...options, defaultProvider: agent.provider });
  options.provider = selected.provider;
  options.model = selected.model;
  if (selected.provider === agent.provider) inheritForkSettings(agent, options);
  if (!options.workspace) options.cwd ??= agent.cwd;
  const context = await client.buildAgentForkContext(agentId, {
    boundaryMessageId: source.boundaryMessageId,
  });
  if (!context.attachment)
    throw {
      code: "FORK_CONTEXT_UNAVAILABLE",
      message: "The daemon returned no fork history attachment.",
    };
  return [context.attachment];
}

function inheritForkSettings(agent: AgentSnapshotPayload, options: AgentRunOptions): void {
  options.model ??= agent.model ?? agent.runtimeInfo?.model ?? undefined;
  options.mode ??= agent.currentModeId ?? agent.runtimeInfo?.modeId ?? undefined;
  options.thinking ??= agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? undefined;
  const inherited = Object.fromEntries(
    (agent.features ?? []).map((feature) => [feature.id, feature.value]),
  );
  const explicit = parseFeatureValues(options.feature, options.featuresJson);
  options.featuresJson = JSON.stringify({ ...inherited, ...explicit });
  options.feature = undefined;
}

export function validateAgentForkBoundary(options: AgentRunOptions): void {
  const boundary = options.forkSource?.boundaryMessageId;
  if (boundary !== undefined && !boundary.trim()) {
    throw { code: "INVALID_ARGUMENT", message: "--at must name an assistant message." };
  }
  if (options.forkSource && boundary !== undefined)
    options.forkSource.boundaryMessageId = boundary.trim();
}
