import type {
  AgentActivityResult,
  AgentDirectoryQueryRequest,
  AgentStatusResult,
  AgentListItemPayload,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { expandUserPath, isSameOrDescendantPath } from "../path-utils.js";
import { AgentDirectory } from "./directory.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { buildStoredAgentPayload, toAgentListItemPayload } from "./agent-projections.js";
import { curateAgentActivity } from "./activity-curator.js";
import { selectItemsByProjectedLimit } from "./timeline-projection.js";
import { isStoredAgentProviderAvailable } from "../persistence-hooks.js";
import { serializeSnapshotWithMetadata } from "./mcp-shared.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

export interface AgentQueryServiceDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list">;
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

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    timestamp(agent.updatedAt),
    timestamp(agent.lastUserMessageAt),
    timestamp(agent.attentionTimestamp),
    timestamp(agent.archivedAt),
    timestamp(agent.createdAt),
  );
}

function compareAgentListItems(left: AgentListItemPayload, right: AgentListItemPayload): number {
  const attentionDelta =
    Number(right.requiresAttention ?? false) - Number(left.requiresAttention ?? false);
  if (attentionDelta !== 0) return attentionDelta;

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as const;
  const statusDelta = statusOrder[left.status] - statusOrder[right.status];
  if (statusDelta !== 0) return statusDelta;

  return resolveActivityTime(right) - resolveActivityTime(left);
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
  const statusFilter = query.statuses?.length ? new Set(query.statuses) : null;
  const sinceMs = Date.now() - (query.sinceHours ?? 48) * 60 * 60 * 1000;
  const registeredProviders = new Set(
    dependencies.providerSnapshotManager.listRegisteredProviderIds(),
  );
  const directory = new AgentDirectory({
    manager: dependencies.agentManager,
    storage: dependencies.agentStorage,
    workspaces: dependencies.workspaceRegistry,
    projectLive: (snapshot: ManagedAgent) =>
      serializeSnapshotWithMetadata(dependencies.agentStorage, snapshot, dependencies.logger),
    projectStored: (record) => buildStoredAgentPayload(record, registeredProviders),
    isProviderVisible: () => true,
    isStoredProviderAvailable: (record) =>
      isStoredAgentProviderAvailable(record, registeredProviders),
  });

  return (
    await directory.list({
      includeBackground: query.includeBackground ?? false,
      includeArchived: query.includeArchived ?? false,
    })
  )
    .map(toAgentListItemPayload)
    .filter((agent) => !requestedCwd || isSameOrDescendantPath(requestedCwd, agent.cwd))
    .filter((agent) => !statusFilter || statusFilter.has(agent.status))
    .filter((agent) => !agent.archivedAt || resolveActivityTime(agent) >= sinceMs)
    .sort(compareAgentListItems)
    .slice(0, query.limit ?? 50);
}

export async function getAgentStatus(input: AgentStatusServiceInput): Promise<AgentStatusResult> {
  const { dependencies, agentId } = input;
  const liveSnapshot = dependencies.agentManager.getAgent(agentId);
  if (liveSnapshot) {
    return {
      status: liveSnapshot.lifecycle,
      snapshot: await serializeSnapshotWithMetadata(
        dependencies.agentStorage,
        liveSnapshot,
        dependencies.logger,
      ),
    };
  }

  const record = await dependencies.agentStorage.get(agentId);
  if (!record || record.internal) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const snapshot = buildStoredAgentPayload(
    record,
    new Set(dependencies.providerSnapshotManager.listRegisteredProviderIds()),
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
  const selection = selectItemsByProjectedLimit({
    items: timeline,
    direction: "tail",
    limit: limit ?? 0,
  });
  const content = curateAgentActivity(selection.items);
  const { totalProjected, shownProjected } = selection;
  const noun = totalProjected === 1 ? "activity" : "activities";
  const countHeader =
    limit && shownProjected < totalProjected
      ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${limit})`
      : `Showing all ${totalProjected} ${noun}`;

  return {
    agentId,
    updateCount: timeline.length,
    currentModeId: snapshot?.currentModeId ?? null,
    content: `${countHeader}\n\n${content}`,
  };
}
