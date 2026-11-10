import { decodeExpoForeignAgentIdentifier } from "@getpaseo/protocol/android-notification-tag";
import {
  agentNotificationKey,
  readAgentNotificationData,
  type TrackedNotificationReason,
} from "./key";
import { classifyUntrackedPush, type UntrackedPush } from "./caught-up";
import type { NotificationDismissal } from "./dismissal";

export interface PresentedNotification {
  identifier: string;
  data: unknown;
  title?: string | null;
  body?: string | null;
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

function readPresentedAgent(notification: PresentedNotification) {
  const data = readAgentNotificationData(notification.data);
  const tagged = decodeExpoForeignAgentIdentifier(notification.identifier);
  if (
    data &&
    tagged &&
    (data.serverId !== tagged.serverId ||
      data.agentId !== tagged.agentId ||
      data.reason !== tagged.reason)
  )
    return null;
  return data ?? tagged;
}

/**
 * Mirrors the OS notification shade into the tracker. Pushes arrive while the app is not
 * running, so the shade, not the send path, is the list of notifications to track. Android
 * stacks every push, so one thread can have several presented notifications.
 */
export function createPresentedNotificationSync(input: {
  api: PresentedNotificationsApi;
  tracker: () => Pick<NotificationDismissal, "track" | "forget">;
  isTrackable?: (data: unknown) => boolean;
  /** Pushes with no thread data: Android posts those itself while the app isn't running. */
  onUntracked?: (pushes: UntrackedPush[]) => void;
}): PresentedNotificationSync {
  /** Newest delivery tracked per thread; a dismissal covers nothing delivered after it. */
  const trackedAt = new Map<string, number>();
  const trackedIdentifiers = new Map<string, Set<string>>();

  async function readThreads() {
    const threads = new Map<
      string,
      {
        identity: { serverId: string; agentId: string };
        reason: TrackedNotificationReason;
        deliveredAt: number;
        identifiers: Set<string>;
      }
    >();
    const untracked: UntrackedPush[] = [];
    for (const notification of await input.api.list()) {
      if (input.isTrackable && !input.isTrackable(notification.data)) continue;
      const agent = readPresentedAgent(notification);
      if (!agent) {
        untracked.push({
          identifier: notification.identifier,
          kind: classifyUntrackedPush(notification.title ?? "", notification.body ?? ""),
          title: notification.title ?? "",
          deliveredAt: notification.deliveredAt,
        });
        continue;
      }
      const key = agentNotificationKey(agent);
      const thread = threads.get(key);
      if (!thread) {
        threads.set(key, {
          identity: { serverId: agent.serverId, agentId: agent.agentId },
          reason: agent.reason,
          deliveredAt: notification.deliveredAt,
          identifiers: new Set([notification.identifier]),
        });
        continue;
      }
      thread.identifiers.add(notification.identifier);
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
    return { threads, untracked };
  }

  async function syncOnce(): Promise<void> {
    const { threads, untracked } = await readThreads();
    input.onUntracked?.(untracked);
    const tracker = input.tracker();
    for (const [key, thread] of threads) {
      if ((trackedAt.get(key) ?? -1) >= thread.deliveredAt) continue;
      trackedIdentifiers.set(key, thread.identifiers);
      tracker.track(thread.identity, thread.reason, { createdAt: thread.deliveredAt });
      trackedAt.set(key, thread.deliveredAt);
    }
    // Cleared by the user: nothing left to dismiss for the thread.
    for (const key of trackedAt.keys()) {
      if (threads.has(key)) continue;
      trackedAt.delete(key);
      trackedIdentifiers.delete(key);
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
      const observed = new Map(
        keys.map((key) => [key, trackedIdentifiers.get(key) ?? new Set<string>()]),
      );
      for (const key of keys) {
        trackedAt.delete(key);
        trackedIdentifiers.delete(key);
      }
      const dismissals: Promise<void>[] = [];
      for (const notification of await input.api.list()) {
        const agent = readPresentedAgent(notification);
        const cutoff = agent ? cutoffs.get(agentNotificationKey(agent)) : undefined;
        // A push that arrived after the tracked one waits for the next sync.
        if (
          cutoff === undefined ||
          notification.deliveredAt > cutoff ||
          !observed.get(agentNotificationKey(agent!))?.has(notification.identifier)
        )
          continue;
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
