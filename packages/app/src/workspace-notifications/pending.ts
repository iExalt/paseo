import { useCallback, useSyncExternalStore } from "react";

const pendingKeys = new Set<string>();
const listenersByKey = new Map<string, Set<() => void>>();

function keyFor(serverId: string, workspaceId: string): string {
  return JSON.stringify([serverId, workspaceId]);
}

function notify(key: string): void {
  for (const listener of listenersByKey.get(key) ?? []) listener();
}

export function isWorkspaceNotificationMutationPending(
  serverId: string,
  workspaceId: string,
): boolean {
  return pendingKeys.has(keyFor(serverId, workspaceId));
}

export function claimWorkspaceNotificationMutation(
  serverId: string,
  workspaceId: string,
): (() => void) | null {
  const key = keyFor(serverId, workspaceId);
  if (pendingKeys.has(key)) return null;
  pendingKeys.add(key);
  notify(key);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingKeys.delete(key);
    notify(key);
  };
}

export function subscribeWorkspaceNotificationMutation(
  serverId: string,
  workspaceId: string,
  listener: () => void,
): () => void {
  const key = keyFor(serverId, workspaceId);
  const listeners = listenersByKey.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByKey.delete(key);
  };
}

export function useWorkspaceNotificationMutationPending(
  serverId: string,
  workspaceId: string,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeWorkspaceNotificationMutation(serverId, workspaceId, listener),
    [serverId, workspaceId],
  );
  const getSnapshot = useCallback(
    () => isWorkspaceNotificationMutationPending(serverId, workspaceId),
    [serverId, workspaceId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
