import { create } from "zustand";

/** The Android notification channel push notifications use. */
export const PUSH_CHANNEL_ID = "default";

/**
 * How far this device got registering its push token with a host. The host does not
 * acknowledge a registration, so `sent` means the token went out on a live
 * connection, not that the host stored it.
 */
export type PushRegistrationStatus =
  | "pending"
  | "sent"
  | "not-connected"
  | "no-permission"
  | "no-token"
  | "failed";

export const usePushRegistrationStore = create<Record<string, PushRegistrationStatus>>(() => ({}));

const reregisterByServerId = new Map<string, () => void>();

export function setPushRegistrationStatus(serverId: string, status: PushRegistrationStatus): void {
  usePushRegistrationStore.setState({ [serverId]: status });
}

/** Lets a running subscription be re-run from settings; returns the cleanup. */
export function provideReregister(serverId: string, reregister: () => void): () => void {
  reregisterByServerId.set(serverId, reregister);
  return () => {
    if (reregisterByServerId.get(serverId) === reregister) reregisterByServerId.delete(serverId);
    usePushRegistrationStore.setState((state) => {
      const { [serverId]: _removed, ...rest } = state;
      return rest;
    }, true);
  };
}

/** Resolves the token again, which may show the permission prompt, then re-sends it. */
export function reregisterPushToken(serverId: string): void {
  reregisterByServerId.get(serverId)?.();
}
