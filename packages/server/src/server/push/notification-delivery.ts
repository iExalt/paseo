import type pino from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import type { PushNotifications, PushNotificationSender, PushPayload } from "./index.js";
import type { NotificationEpisode } from "./lifecycle-store.js";

interface NotificationDeliveryOptions {
  serverId: string;
  storage: Pick<AgentStorage, "applySnapshot" | "flush" | "notificationLifecycle">;
  pushNotifications: Pick<PushNotifications, "resolveLifecycle">;
  sender: PushNotificationSender;
  logger: pino.Logger;
}

export class NotificationDelivery {
  private readonly abort = new AbortController();
  private readonly snapshots = new Set<Promise<NotificationEpisode[]>>();
  private readonly sends = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null;
  private retry: ReturnType<typeof setInterval> | null;
  private drain: Promise<void> | null = null;

  constructor(private readonly options: NotificationDeliveryOptions) {
    const retryLifecycle = () =>
      void this.flushResolutions().catch((err) => {
        options.logger.warn({ err }, "Failed to deliver lifecycle resolutions; retained for retry");
      });
    this.unsubscribe = options.storage.notificationLifecycle.subscribe(retryLifecycle);
    this.retry = setInterval(retryLifecycle, 30_000);
    this.retry.unref();
    retryLifecycle();
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  async captureSnapshot(agent: ManagedAgent): Promise<NotificationEpisode[]> {
    if (this.stopped) return [];
    const snapshot = this.options.storage.applySnapshot(agent);
    this.snapshots.add(snapshot);
    try {
      return await snapshot;
    } finally {
      this.snapshots.delete(snapshot);
    }
  }

  sendAttention(input: { notification: PushPayload; agentId: string }): void {
    if (this.stopped) return;
    const send = this.options.sender.send(input.notification, this.abort.signal).catch((err) => {
      this.options.logger.warn({ err, agentId: input.agentId }, "Failed to send push notification");
    });
    this.sends.add(send);
    void send.finally(() => this.sends.delete(send));
  }

  flushResolutions(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drain) return this.drain;
    const work = async () => {
      await this.options.storage.flush();
      for (const episode of await this.options.storage.notificationLifecycle.pending()) {
        if (this.stopped) break;
        const accepted = await this.options.pushNotifications.resolveLifecycle?.(
          this.options.serverId,
          episode,
          this.abort.signal,
        );
        // An accepted but unacknowledged cancellation remains safe to retry after restart.
        if (!accepted || this.stopped) break;
        await this.options.storage.notificationLifecycle.delivered(episode.episodeId);
      }
    };
    this.drain = work().finally(() => {
      this.drain = null;
    });
    return this.drain;
  }

  prepareForShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    this.abort.abort();
  }

  async close(): Promise<void> {
    this.prepareForShutdown();
    // No new notification writes can be admitted after the shutdown barrier.
    await Promise.allSettled([...this.snapshots, ...this.sends]);
    await this.drain?.catch((err) => {
      this.options.logger.warn({ err }, "Lifecycle resolution retained during shutdown");
    });
  }
}
