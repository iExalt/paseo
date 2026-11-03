import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ComposerAttachment } from "@/attachments/types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Queued prompts live in the session store, which is memory only, so a reload or app kill lost
// every prompt still waiting for its agent. This mirror is written on every queue change. The
// session store restores a server's queues from it, and attachment GC keeps their images.

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

type QueuesByServer = Record<string, Record<string, QueuedMessage[]>>;

const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  // Only this mirror writes these, so the attachment union is not re-validated here.
  attachments: z.array(
    z.custom<ComposerAttachment>(
      (value) => typeof value === "object" && value !== null && "kind" in value,
    ),
  ),
});

const PersistedQueuedMessagesSchema = z.object({
  byServer: z.record(z.string(), z.record(z.string(), z.array(QueuedMessageSchema))),
});

let readFailed = false;
const readFailureWaiters = new Set<() => void>();
function markSnapshotReadFailed(): void {
  readFailed = true;
  for (const release of readFailureWaiters) release();
  readFailureWaiters.clear();
}

interface QueuedMessageSnapshotState {
  byServer: QueuesByServer;
  save: (serverId: string, queues: ReadonlyMap<string, QueuedMessage[]>) => void;
}

export const useQueuedMessageSnapshot = create<QueuedMessageSnapshotState>()(
  persist(
    (set) => ({
      byServer: {},
      save: (serverId, queues) =>
        set((state) => {
          const byServer = { ...state.byServer };
          const nonEmpty = [...queues].filter(([, queue]) => queue.length > 0);
          if (nonEmpty.length > 0) byServer[serverId] = Object.fromEntries(nonEmpty);
          else delete byServer[serverId];
          return { byServer };
        }),
    }),
    {
      name: "paseo-queued-messages",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedQueuedMessagesSchema),
      partialize: ({ byServer }) => ({ byServer }),
      // A failed storage read never finishes hydration; release attachment GC anyway, since
      // nothing was restored for it to protect.
      onRehydrateStorage: () => (_state, error) => {
        if (error) markSnapshotReadFailed();
      },
    },
  ),
);

export function readQueuedMessageSnapshot(serverId: string): Map<string, QueuedMessage[]> {
  return new Map(Object.entries(useQueuedMessageSnapshot.getState().byServer[serverId] ?? {}));
}

/** Resolves once the snapshot has loaded, so attachment GC never runs without its images. */
export function whenQueuedMessageSnapshotLoaded(): Promise<void> {
  if (readFailed || useQueuedMessageSnapshot.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const release = () => {
      unsubscribe();
      readFailureWaiters.delete(release);
      resolve();
    };
    const unsubscribe = useQueuedMessageSnapshot.persist.onFinishHydration(release);
    readFailureWaiters.add(release);
  });
}

export function collectQueuedMessageSnapshotImageIds(referencedIds: Set<string>): void {
  const queues = Object.values(useQueuedMessageSnapshot.getState().byServer).flatMap((byAgent) =>
    Object.values(byAgent),
  );
  for (const message of queues.flat()) {
    for (const attachment of message.attachments) {
      if (attachment.kind === "image") referencedIds.add(attachment.metadata.id);
    }
  }
}
