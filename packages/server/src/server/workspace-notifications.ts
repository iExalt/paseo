import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

/**
 * Shared readiness gate for accepting workspace notification policy and advertising support.
 * Enable only after both agent and terminal delivery enforce the persisted policy.
 */
export const WORKSPACE_NOTIFICATIONS_ENABLED = true;

export type WorkspaceNotifications = PersistedWorkspaceRecord["notifications"];

/** Persist a workspace policy through the registry's existing serialized update path. */
export function updateWorkspaceNotifications(
  registry: Pick<WorkspaceRegistry, "update">,
  workspaceId: string,
  notifications: WorkspaceNotifications,
): Promise<PersistedWorkspaceRecord | null> {
  return registry.update(workspaceId, (workspace) => ({
    ...workspace,
    notifications,
    updatedAt: new Date().toISOString(),
  }));
}
