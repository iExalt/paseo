import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ANDROID_NOTIFICATION_LIFETIME_MS } from "@getpaseo/protocol/android-notification-lifecycle";
import { writePrivateFileAtomic } from "../private-files.js";

const EpisodeSchema = z.object({
  agentId: z.string(),
  lane: z.enum(["attention", "question"]),
  episodeId: z.uuid(),
  issuedAt: z.number(),
  expiresAt: z.number(),
});
export type NotificationEpisode = z.infer<typeof EpisodeSchema>;
const StateSchema = z.object({
  active: z.array(EpisodeSchema),
  pending: z.array(EpisodeSchema),
});

/** The episode identity survives daemon restarts; notification delivery never owns unread state. */
export class NotificationLifecycleStore {
  private state: z.infer<typeof StateSchema> = { active: [], pending: [] };
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(
    private readonly filePath: string,
    private readonly now = Date.now,
    private readonly write = writePrivateFileAtomic,
  ) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      if (!this.loaded) {
        try {
          this.state = StateSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
      }
      return action();
    });
    this.queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  observe(
    agentId: string,
    input: { attention: boolean; questions?: boolean; removed?: boolean },
  ): Promise<NotificationEpisode[]> {
    return this.serialize(async () => {
      const active = [...this.state.active];
      const pending = [...this.state.pending];
      let changed = false;
      for (const lane of ["attention", "question"] as const) {
        const activeCondition = lane === "attention" ? input.attention : input.questions;
        const desired = input.removed ? false : activeCondition;
        if (desired === undefined) continue;
        const index = active.findIndex(
          (episode) => episode.agentId === agentId && episode.lane === lane,
        );
        if (desired && index < 0) {
          if (active.length + pending.length >= 4096)
            throw new Error(
              "Notification lifecycle outbox is full; delivery is held until resolutions drain",
            );
          const issuedAt = this.now();
          active.push({
            agentId,
            lane,
            episodeId: randomUUID(),
            issuedAt,
            expiresAt: issuedAt + ANDROID_NOTIFICATION_LIFETIME_MS,
          });
          changed = true;
        } else if (!desired && index >= 0) {
          pending.push(active[index]!);
          active.splice(index, 1);
          changed = true;
        }
      }
      if (!changed) return this.state.active.filter((episode) => episode.agentId === agentId);
      await this.commit({ active, pending });
      for (const listener of this.listeners) listener();
      return this.state.active.filter((episode) => episode.agentId === agentId);
    });
  }
  async reconcile(
    records: ReadonlyArray<{
      id: string;
      requiresAttention?: boolean;
      archivedAt?: string | null;
      notificationPendingPermissions?: string[];
    }>,
  ): Promise<void> {
    const ids = new Set(records.map((record) => record.id));
    for (const record of records)
      await this.observe(record.id, {
        attention: record.requiresAttention === true,
        questions:
          record.notificationPendingPermissions === undefined
            ? undefined
            : record.notificationPendingPermissions.length > 0,
        removed: !!record.archivedAt,
      });
    for (const episode of await this.active()) {
      if (!ids.has(episode.agentId))
        await this.observe(episode.agentId, { attention: false, removed: true });
    }
  }
  active(): Promise<NotificationEpisode[]> {
    return this.serialize(async () => [...this.state.active]);
  }
  pending(): Promise<NotificationEpisode[]> {
    return this.serialize(async () => [...this.state.pending]);
  }
  delivered(episodeId: string): Promise<void> {
    return this.serialize(async () => {
      await this.commit({
        ...this.state,
        pending: this.state.pending.filter((episode) => episode.episodeId !== episodeId),
      });
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private async commit(state: z.infer<typeof StateSchema>): Promise<void> {
    await this.write(this.filePath, JSON.stringify(state) + "\n");
    this.state = state;
  }
}
