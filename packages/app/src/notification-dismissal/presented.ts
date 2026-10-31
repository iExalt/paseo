import {
  agentNotificationKey,
  readAgentNotificationData,
  type TrackedNotificationReason,
} from "./key";
import type { NotificationDismissalTracker } from "./tracker";

export interface PresentedNotification {
  identifier: string;
  data: unknown;
  /** Device clock delivery time, in milliseconds. */
  deliveredAt: number;
}

export interface PresentedNotificationsApi {
  list(): Promise<PresentedNotification[]>;
  dismiss(identifier: string): Promise<void>;
}

export interface PresentedNotificationSync {
  /** Re-reads the notification shade: on foreground and when a push arrives. */
  sync(): Promise<void>;
  /** The tracker's dismiss callback. */
  dismiss(keys: string[]): Promise<void>;
}

/**
 * Mirrors the OS notification shade into the tracker. Pushes arrive while the app is not
 * running, so the shade, not the send path, is the list of notifications to track. Android
 * stacks every push, so one thread can have several presented notifications.
 */
export function createPresentedNotificationSync(input: {
  api: PresentedNotificationsApi;
  tracker: () => NotificationDismissalTracker;
  isTrackable?: (data: unknown) => boolean;
}): PresentedNotificationSync {
  /** Newest delivery tracked per thread; a dismissal covers nothing delivered after it. */
  const trackedAt = new Map<string, number>();

  async function readThreads() {
    const threads = new Map<
      string,
      {
        identity: { serverId: string; agentId: string };
        reason: TrackedNotificationReason;
        deliveredAt: number;
      }
    >();
    for (const notification of await input.api.list()) {
      if (input.isTrackable && !input.isTrackable(notification.data)) continue;
      const agent = readAgentNotificationData(notification.data);
      if (!agent) continue;
      const key = agentNotificationKey(agent);
      const thread = threads.get(key);
      if (!thread) {
        threads.set(key, {
          identity: { serverId: agent.serverId, agentId: agent.agentId },
          reason: agent.reason,
          deliveredAt: notification.deliveredAt,
        });
        continue;
      }
      // The newest notification decides what the thread is waiting on. A tie can't tell a
      // question from a turn end, so it waits for both to clear.
      if (notification.deliveredAt > thread.deliveredAt) {
        thread.deliveredAt = notification.deliveredAt;
        thread.reason = agent.reason;
      } else if (
        notification.deliveredAt === thread.deliveredAt &&
        thread.reason !== agent.reason
      ) {
        thread.reason = "unknown";
      }
    }
    return threads;
  }

  async function syncOnce(): Promise<void> {
    const threads = await readThreads();
    const tracker = input.tracker();
    for (const [key, thread] of threads) {
      if ((trackedAt.get(key) ?? -1) >= thread.deliveredAt) continue;
      tracker.track(thread.identity, thread.reason, { createdAt: thread.deliveredAt });
      trackedAt.set(key, thread.deliveredAt);
    }
    // Cleared by the user: nothing left to dismiss for the thread.
    for (const key of trackedAt.keys()) {
      if (threads.has(key)) continue;
      trackedAt.delete(key);
      tracker.forget(key);
    }
  }

  // One sync at a time: an older listing finishing late would forget a push a newer one tracked.
  let running: Promise<void> | null = null;
  let rerun = false;
  function sync(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await syncOnce();
        } while (rerun);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    sync,
    async dismiss(keys) {
      const cutoffs = new Map(keys.map((key) => [key, trackedAt.get(key) ?? -1]));
      for (const key of keys) trackedAt.delete(key);
      const dismissals: Promise<void>[] = [];
      for (const notification of await input.api.list()) {
        const agent = readAgentNotificationData(notification.data);
        const cutoff = agent ? cutoffs.get(agentNotificationKey(agent)) : undefined;
        // A push that arrived after the tracked one waits for the next sync.
        if (cutoff === undefined || notification.deliveredAt > cutoff) continue;
        dismissals.push(input.api.dismiss(notification.identifier).catch(() => undefined));
      }
      await Promise.all(dismissals);
    },
  };
}

/** expo-notifications reports delivery in seconds on iOS and milliseconds on Android. */
export function presentedAtMs(platform: string, date: number): number {
  return platform === "ios" ? date * 1000 : date;
}
