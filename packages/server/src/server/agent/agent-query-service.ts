import type {
  AgentActivityResult,
  AgentDirectoryQueryRequest,
  AgentStatusResult,
  AgentListItemPayload,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { expandUserPath } from "../path-utils.js";
import { AgentDirectory } from "./directory.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { buildStoredAgentPayload, selectAgentListItems } from "./agent-projections.js";
import { summarizeAgentActivity } from "./activity-curator.js";
import { isStoredAgentProviderAvailable } from "../persistence-hooks.js";
import { serializeSnapshotWithMetadata } from "./mcp-shared.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

export interface AgentQueryServiceDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "listActive">;
  logger: Logger;
}

export interface AgentDirectoryQueryInput extends Pick<
  AgentDirectoryQueryRequest,
  | "includeBackground"
  | "includeArchived"
  | "cwd"
  | "callerAgentId"
  | "sinceHours"
  | "statuses"
  | "limit"
> {}

export interface AgentDirectoryQueryServiceInput {
  dependencies: AgentQueryServiceDependencies;
  query: AgentDirectoryQueryInput;
}

export interface AgentStatusServiceInput {
  dependencies: AgentQueryServiceDependencies;
  agentId: string;
}

export interface AgentActivityServiceInput extends AgentStatusServiceInput {
  limit?: number;
}

async function projectLiveAgent(dependencies: AgentQueryServiceDependencies, agent: ManagedAgent) {
  const snapshot = await serializeSnapshotWithMetadata(
    dependencies.agentStorage,
    agent,
    dependencies.logger,
  );
  const backgroundWork = dependencies.agentManager.getAgentBackgroundWorkSummary(agent.id);
  return backgroundWork ? { ...snapshot, backgroundWork } : snapshot;
}

export async function queryAgentDirectory(
  input: AgentDirectoryQueryServiceInput,
): Promise<AgentListItemPayload[]> {
  const { dependencies, query } = input;
  if (!dependencies.workspaceRegistry) {
    throw new Error("Workspace registry is not configured");
  }

  const caller = query.callerAgentId
    ? dependencies.agentManager.getAgent(query.callerAgentId)
    : null;
  if (query.callerAgentId && !caller) {
    throw new Error(`Parent agent ${query.callerAgentId} not found`);
  }

  const requestedCwd = query.cwd?.trim() ? expandUserPath(query.cwd) : (caller?.cwd ?? undefined);
  const registeredProviders = new Set(
    dependencies.providerSnapshotManager.listRegisteredProviderIds(),
  );
  const directory = new AgentDirectory({
    manager: dependencies.agentManager,
    storage: dependencies.agentStorage,
    workspaces: dependencies.workspaceRegistry,
    projectLive: (snapshot) => projectLiveAgent(dependencies, snapshot),
    projectStored: (record) =>
      buildStoredAgentPayload(
        record,
        registeredProviders,
        (provider, own) => dependencies.agentManager.effectiveOptionsFor(provider, own),
        dependencies.agentManager.getAgentBackgroundWorkSummary(record.id),
      ),
    isProviderVisible: () => true,
    isStoredProviderAvailable: (record) =>
      isStoredAgentProviderAvailable(record, registeredProviders),
  });

  const agents = await directory.list({
    includeBackground: query.includeBackground ?? false,
    includeArchived: query.includeArchived ?? false,
  });
  return selectAgentListItems(agents, {
    cwd: requestedCwd,
    statuses: query.statuses,
    sinceHours: query.sinceHours ?? 48,
    limit: query.limit ?? 50,
  });
}

export async function getAgentStatus(input: AgentStatusServiceInput): Promise<AgentStatusResult> {
  const { dependencies, agentId } = input;
  const liveSnapshot = dependencies.agentManager.getAgent(agentId);
  if (liveSnapshot) {
    return {
      status: liveSnapshot.lifecycle,
      snapshot: await projectLiveAgent(dependencies, liveSnapshot),
    };
  }

  const record = await dependencies.agentStorage.get(agentId);
  if (!record || record.internal) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const snapshot = buildStoredAgentPayload(
    record,
    new Set(dependencies.providerSnapshotManager.listRegisteredProviderIds()),
    (provider, own) => dependencies.agentManager.effectiveOptionsFor(provider, own),
    dependencies.agentManager.getAgentBackgroundWorkSummary(record.id),
  );
  return { status: snapshot.status, snapshot };
}

export async function getAgentActivity(
  input: AgentActivityServiceInput,
): Promise<AgentActivityResult> {
  const { dependencies, agentId, limit } = input;
  await ensureAgentLoaded(agentId, {
    agentManager: dependencies.agentManager,
    agentStorage: dependencies.agentStorage,
    logger: dependencies.logger,
  });
  const timeline = dependencies.agentManager.getTimeline(agentId);
  const snapshot = dependencies.agentManager.getAgent(agentId);
  return {
    agentId,
    currentModeId: snapshot?.currentModeId ?? null,
    ...summarizeAgentActivity(timeline, limit),
  };
}
