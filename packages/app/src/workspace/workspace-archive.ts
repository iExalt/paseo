import { queryClient } from "@/data/query-client";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "@/hooks/agent-history-query-key";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  getWorkspaceArchiveUndoArchivedAgentIds,
  isWorkspaceArchiveIntentCurrent,
  markWorkspaceArchivePending,
  markWorkspaceArchiveUndoPending,
  settleWorkspaceArchiveIntent,
  type WorkspaceArchiveIntent,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import { i18n } from "@/i18n/i18next";

export interface WorkspaceArchiveTarget {
  serverId: string;
  workspaceId: string;
}

const pendingArchiveAttempts = new Set<string>();

/** Checks and starts one archive at a time for a workspace. */
export async function runWorkspaceArchiveAttempt(input: {
  workspace: WorkspaceArchiveTarget;
  confirm?: () => Promise<boolean>;
  archive: () => Promise<void>;
}): Promise<void> {
  const { serverId, workspaceId } = input.workspace;
  const key = JSON.stringify([serverId, workspaceId]);
  if (pendingArchiveAttempts.has(key)) return;

  pendingArchiveAttempts.add(key);
  try {
    if (input.confirm && !(await input.confirm())) return;
    if (!isWorkspaceListed(input.workspace)) return;
    // Archive hides the row synchronously. Undo can restore it and start a new
    // archive while the previous daemon request is still settling.
    return input.archive();
  } finally {
    pendingArchiveAttempts.delete(key);
  }
}

interface WorkspaceArchiveClient {
  archiveWorkspace: (workspaceId: string) => Promise<{ error: string | null; canceled?: boolean }>;
}

interface WorkspaceArchiveUndoClient {
  undoWorkspaceArchive: (workspaceId: string) => Promise<void>;
}

/** `canceled`: an undo stopped the archive on the host before it finished. */
export type WorkspaceArchiveOutcome = "archived" | "canceled";

export interface OptimisticWorkspaceArchive {
  /** The row as it was before the archive hid it, for undo to put back. */
  hidden: WorkspaceDescriptor | null;
  /** Active agents in this workspace at archive time, so undo only marks them as unarchiving. */
  archivedAgentIds: ReadonlySet<string>;
  done: Promise<WorkspaceArchiveOutcome>;
}

interface OptimisticWorkspaceArchiveSnapshot {
  workspace: WorkspaceDescriptor | null;
  archivedAgentIds: ReadonlySet<string>;
  intent: WorkspaceArchiveIntent;
}

export interface WorkspaceArchiveFailure {
  serverId: string;
  workspaceId: string;
  error: unknown;
}

function isWorkspaceArchiveFailure(error: unknown): error is WorkspaceArchiveFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "serverId" in error &&
    typeof error.serverId === "string" &&
    "workspaceId" in error &&
    typeof error.workspaceId === "string" &&
    "error" in error
  );
}

function findListedWorkspace(workspace: WorkspaceArchiveTarget): WorkspaceDescriptor | null {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  return workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
}

/** True when the workspace is in this client's list, for example after another client restored it. */
export function isWorkspaceListed(workspace: WorkspaceArchiveTarget): boolean {
  return findListedWorkspace(workspace) !== null;
}

function listActiveWorkspaceAgentIds(workspace: WorkspaceArchiveTarget): Set<string> {
  const agents = useSessionStore.getState().sessions[workspace.serverId]?.agents;
  const activeAgentIds = new Set<string>();
  const targetWorkspaceId = normalizeWorkspaceOpaqueId(workspace.workspaceId);
  if (!agents || !targetWorkspaceId) return activeAgentIds;
  for (const agent of agents.values()) {
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) === targetWorkspaceId && !agent.archivedAt) {
      activeAgentIds.add(agent.id);
    }
  }
  return activeAgentIds;
}

function hideWorkspaceOptimistically(
  workspace: WorkspaceArchiveTarget,
): OptimisticWorkspaceArchiveSnapshot {
  const snapshot = findListedWorkspace(workspace);
  const archivedAgentIds = listActiveWorkspaceAgentIds(workspace);
  const pendingUndoArchivedAgentIds = getWorkspaceArchiveUndoArchivedAgentIds(workspace);
  if (pendingUndoArchivedAgentIds) {
    for (const agentId of pendingUndoArchivedAgentIds) {
      archivedAgentIds.add(agentId);
    }
  }
  const intent = markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  getHostRuntimeStore().projectWorkspaceArchiveIntent(workspace.serverId, workspace.workspaceId);
  return { workspace: snapshot, archivedAgentIds, intent };
}

async function reconcileWorkspaceArchive(
  workspace: WorkspaceArchiveTarget,
  intent: WorkspaceArchiveIntent,
  present: boolean,
): Promise<void> {
  if (!isWorkspaceArchiveIntentCurrent(intent)) return;
  try {
    await getHostRuntimeStore().reconcileWorkspaceArchive(
      workspace.serverId,
      workspace.workspaceId,
      present,
    );
  } catch (error) {
    // A directory refresh failure does not change the outcome of the mutation.
    // Reconnect or a later refresh will reconcile the retained baseline.
    console.warn("[workspace-archive] directory reconciliation failed", error);
  }
}

/** History fetched before the archive still lists the workspace's agents as active. */
function invalidateAgentHistory(serverId: string): void {
  void queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(serverId) });
  void queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() });
}

async function archiveWorkspaceOrThrow(input: {
  client: WorkspaceArchiveClient;
  workspaceId: string;
}): Promise<WorkspaceArchiveOutcome> {
  const payload = await input.client.archiveWorkspace(input.workspaceId);
  if (payload.canceled) {
    return "canceled";
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  return "archived";
}

/**
 * Hides the row now and archives it on the host. A failed archive puts the row back, and so
 * does a canceled one: an undo from another client stopped it, so the workspace stays.
 */
export function beginOptimisticWorkspaceArchive(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
}): OptimisticWorkspaceArchive {
  const snapshot = hideWorkspaceOptimistically(input.workspace);
  const done = (async () => {
    try {
      const outcome = await archiveWorkspaceOrThrow({
        client: input.client,
        workspaceId: input.workspace.workspaceId,
      });
      if (outcome === "archived") {
        invalidateAgentHistory(input.workspace.serverId);
      }
      await reconcileWorkspaceArchive(input.workspace, snapshot.intent, outcome === "canceled");
      return outcome;
    } finally {
      if (isWorkspaceArchiveIntentCurrent(snapshot.intent)) {
        settleWorkspaceArchiveIntent(snapshot.intent);
        getHostRuntimeStore().projectWorkspaceArchiveIntent(
          input.workspace.serverId,
          input.workspace.workspaceId,
        );
      }
    }
  })();
  return { hidden: snapshot.workspace, archivedAgentIds: snapshot.archivedAgentIds, done };
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
}): Promise<WorkspaceArchiveOutcome> {
  return beginOptimisticWorkspaceArchive(input).done;
}

/**
 * Puts the archived row back now and asks the host to undo the archive, whether it is still
 * running or already finished. When the request settles, the authoritative directory decides
 * whether the row remains visible.
 */
export async function undoWorkspaceArchiveOptimistically(input: {
  client: WorkspaceArchiveUndoClient;
  workspace: WorkspaceArchiveTarget;
  hidden: WorkspaceDescriptor | null;
  archivedAgentIds?: ReadonlySet<string>;
}): Promise<void> {
  const { serverId, workspaceId } = input.workspace;
  const intent = markWorkspaceArchiveUndoPending({
    serverId,
    workspaceId,
    archivedAgentIds: input.archivedAgentIds,
  });
  getHostRuntimeStore().projectWorkspaceArchiveIntent(
    serverId,
    workspaceId,
    input.hidden ?? undefined,
  );
  let restored = false;
  try {
    await input.client.undoWorkspaceArchive(workspaceId);
    restored = true;
  } finally {
    await reconcileWorkspaceArchive(input.workspace, intent, restored);
    if (isWorkspaceArchiveIntentCurrent(intent)) {
      settleWorkspaceArchiveIntent(intent);
      getHostRuntimeStore().projectWorkspaceArchiveIntent(serverId, workspaceId);
    }
  }
}

export async function archiveWorkspacesOptimistically(input: {
  getClient: (serverId: string) => WorkspaceArchiveClient | null;
  workspaces: WorkspaceArchiveTarget[];
}): Promise<WorkspaceArchiveFailure[]> {
  const results = await Promise.allSettled(
    input.workspaces.map(async (workspace) => {
      const client = input.getClient(workspace.serverId);
      if (!client) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error: new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected")),
        } satisfies WorkspaceArchiveFailure;
      }

      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace,
        });
      } catch (error) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error,
        } satisfies WorkspaceArchiveFailure;
      }
    }),
  );

  return results.flatMap((result) =>
    result.status === "rejected" && isWorkspaceArchiveFailure(result.reason) ? [result.reason] : [],
  );
}
