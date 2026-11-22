import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalAgentStore } from "@cursor/sdk";

/** Correlate the native ID before an SDK send acquires its execution controller. */
export function createCursorRunBinding(store: LocalAgentStore) {
  const admission = new AsyncLocalStorage<{
    agentId: string;
    bind: (runId: string) => Promise<void>;
  }>();

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
        return store.runs.update(input);
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
