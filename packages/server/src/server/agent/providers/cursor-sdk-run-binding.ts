import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalAgentRunDocument, LocalAgentStore } from "@cursor/sdk";

/** Correlate the native ID before an SDK send acquires its execution controller. */
export function createCursorRunBinding(store: LocalAgentStore) {
  const admission = new AsyncLocalStorage<{
    agentId: string;
    bind: (runId: string) => Promise<void>;
  }>();
  const updates = new Map<string, Promise<LocalAgentRunDocument>>();

  // Cursor SDK 1.4.2 updates a run by reading the row and writing a new copy.
  // Run.cancel() writes its cancellation while the run loop writes the
  // cancelled run's usage, so a cancellation read before that write can erase
  // the usage. Serialize each run's writes and keep usage a terminal row has.
  async function write(run: LocalAgentRunDocument): Promise<LocalAgentRunDocument> {
    if (run.status !== "running" && run.usage == null) {
      const stored = await store.runs.get({ agentId: run.agentId, runId: run.runId });
      if (stored?.status === run.status && stored.usage != null) {
        run = { ...run, usage: stored.usage };
      }
    }
    return store.runs.update({ run });
  }

  function update(run: LocalAgentRunDocument): Promise<LocalAgentRunDocument> {
    const key = `${run.agentId}\0${run.runId}`;
    const next = (updates.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => write(run));
    updates.set(key, next);
    void next
      .finally(() => {
        if (updates.get(key) === next) updates.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  const boundStore: LocalAgentStore = {
    agents: store.agents,
    checkpoints: store.checkpoints,
    runEvents: store.runEvents,
    runs: {
      get: (input) => store.runs.get(input),
      create: (input) => store.runs.create(input),
      delete: (input) => store.runs.delete(input),
      list: (input) => store.runs.list(input),
      async update(input) {
        const writer = admission.getStore();
        if (writer?.agentId === input.run.agentId && input.run.status === "running") {
          await writer.bind(input.run.runId);
        }
        return update(input.run);
      },
    },
  };

  return {
    store: boundStore,
    send<T>(agentId: string, bind: (runId: string) => Promise<void>, start: () => Promise<T>) {
      return admission.run({ agentId, bind }, start);
    },
  };
}
