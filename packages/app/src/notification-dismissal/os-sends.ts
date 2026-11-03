import type { DesktopNotificationPayload } from "@/desktop/host";
import type { NotificationDismissal } from "./dismissal";
import {
  agentNotificationGroupId,
  agentNotificationKey,
  parseDeliveredAgentNotification,
  readAgentNotificationData,
} from "./key";

export interface OsNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface TrackedWebNotification {
  addEventListener(type: "close", listener: () => void): void;
  close(): void;
}

/** One agent notification on its way through the browser's permission prompt. */
export interface WebSend {
  /** The tag that gives the thread one notification slot, alerting again on replacement. */
  readonly options: { tag: string; renotify: true };
  /**
   * Settles the send after the permission prompt: show it, or return `result` without
   * showing. A newer send for the thread or a dismissal during the prompt wins.
   */
  afterPermission(granted: boolean): { show: true } | { show: false; result: boolean };
  /** Registers the shown notification so a dismissal closes it. */
  shown(notification: TrackedWebNotification): void;
}

export interface OsNotificationSends {
  /** Sends through the desktop bridge, keyed by thread so a dismissal can remove it. */
  sendDesktop(
    send: (payload: DesktopNotificationPayload) => Promise<boolean>,
    payload: OsNotificationPayload,
  ): Promise<boolean>;
  /** Starts a browser send; null for notifications that name no thread. */
  beginWeb(data: Record<string, unknown> | undefined): WebSend | null;
  /**
   * Tracks desktop notifications this renderer did not send: ones from before a window
   * reload, and on macOS ones from an earlier launch.
   */
  adoptDelivered(delivered: ReadonlyArray<{ id: string; groupId: string }>): void;
}

interface Pending {
  dismissed: boolean;
}

/**
 * Desktop and browser agent notifications, tracked from the moment they are sent so a thread
 * read elsewhere takes its notification with it.
 */
export function createOsNotificationSends(input: {
  /** Created on first use with the callback that removes tracked notifications. */
  createDismissal: (
    dismissThreads: (keys: string[]) => void,
  ) => Pick<NotificationDismissal, "track" | "forget">;
  dismissDesktop: (keys: string[]) => void;
}): OsNotificationSends {
  let dismissal: Pick<NotificationDismissal, "track" | "forget"> | null = null;
  /** Live browser notifications by thread key. Lost on reload; those stay until the user clears them. */
  const liveWebNotifications = new Map<string, TrackedWebNotification>();
  /** Keys tracked while their notification is still being shown, and whether dismissal came first. */
  const pendingNotifications = new Map<string, Pending>();

  function getDismissal() {
    dismissal ??= input.createDismissal((keys) => {
      for (const key of keys) {
        const pending = pendingNotifications.get(key);
        if (pending) pending.dismissed = true;
        liveWebNotifications.get(key)?.close();
        liveWebNotifications.delete(key);
      }
      input.dismissDesktop(keys);
    });
    return dismissal;
  }

  /** Tracks an agent notification before it is shown, so state changes meanwhile are seen. */
  function begin(data: Record<string, unknown> | undefined) {
    const agent = readAgentNotificationData(data);
    if (!agent) return null;
    const key = agentNotificationKey(agent);
    const pending: Pending = { dismissed: false };
    // Registered first: tracking can dismiss synchronously.
    pendingNotifications.set(key, pending);
    getDismissal().track(agent, agent.reason);
    return { key, groupId: agentNotificationGroupId(key, agent.reason), pending };
  }

  /** Ends the pending phase; false when a newer send for the thread took over its slot. */
  function finish(key: string, pending: Pending): boolean {
    if (pendingNotifications.get(key) !== pending) return false;
    pendingNotifications.delete(key);
    return true;
  }

  return {
    async sendDesktop(send, payload) {
      const tracked = begin(payload.data);
      const shown = await send(
        tracked ? { ...payload, id: tracked.key, groupId: tracked.groupId } : payload,
      );
      // A newer send for the thread replaces this notification and owns its entry.
      if (!tracked || !finish(tracked.key, tracked.pending)) return shown;
      if (!shown) getDismissal().forget(tracked.key);
      // Resolved while the main process was showing it; there was nothing to remove yet.
      else if (tracked.pending.dismissed) input.dismissDesktop([tracked.key]);
      return shown;
    },
    beginWeb(data) {
      const tracked = begin(data);
      if (!tracked) return null;
      const { key, pending } = tracked;
      return {
        options: { tag: key, renotify: true },
        afterPermission(granted) {
          // A newer notification for the thread, sent during the wait, owns the slot and its entry.
          if (!finish(key, pending)) return { show: false, result: false };
          if (!granted) {
            getDismissal().forget(key);
            return { show: false, result: false };
          }
          // Resolved while permission was pending: the notification is already out of date.
          if (pending.dismissed) return { show: false, result: true };
          return { show: true };
        },
        shown(notification) {
          // A same-tag notification replaced the previous one; closing the old instance is not needed.
          liveWebNotifications.set(key, notification);
          notification.addEventListener("close", () => {
            // The user cleared it; stop holding the host's directory for it. A newer
            // notification for the thread, live or still pending, keeps the entry.
            if (liveWebNotifications.get(key) !== notification || pendingNotifications.has(key)) {
              return;
            }
            liveWebNotifications.delete(key);
            getDismissal().forget(key);
          });
        },
      };
    },
    adoptDelivered(delivered) {
      for (const notification of delivered) {
        const agent = parseDeliveredAgentNotification(notification);
        if (agent) getDismissal().track(agent, agent.reason, { createdAt: 0, ifAbsent: true });
      }
    },
  };
}
