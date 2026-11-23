import type {
  LocalAgentStore,
  Run,
  RunResult,
  SDKCustomTool,
  SDKMessage,
  SDKUserMessage,
  TokenUsage,
} from "@cursor/sdk";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  CursorOwnerRunInfo,
  CursorOwnerStart,
  CursorOwnerSteer,
} from "./cursor-owner-worker.js";
import { serveCursorStore } from "./cursor-store-proxy.js";
import { requestExecutionOwnerStop } from "./execution-owner.js";
import { openOwnedProcess, type EnrollExecutionOwner, type OwnedProcess } from "./owned-process.js";

function remoteRun(process: OwnedProcess, info: CursorOwnerRunInfo): Run {
  const listeners = new Set<(status: Run["status"]) => void>();
  const { id, agentId } = info;
  let status = info.status;
  function updateStatus(next: Run["status"]): void {
    if (status === next) return;
    status = next;
    for (const listener of listeners) listener(next);
  }
  return {
    id,
    agentId,
    get status() {
      return status;
    },
    supports: (operation) => info.operations.includes(operation),
    unsupportedReason: () => undefined,
    onDidChangeStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async *stream() {
      for (;;) {
        const entry = await process.channel.request<IteratorResult<SDKMessage, void>>("next", {
          id,
        });
        if (entry.done) return;
        yield entry.value;
      }
    },
    conversation: () => process.channel.request("conversation", { id }),
    async wait() {
      const result = await process.channel.request<RunResult>("wait", { id });
      updateStatus(result.status);
      return result;
    },
    async cancel() {
      updateStatus(await process.channel.request<Run["status"]>("cancel", { id }));
    },
    steer: info.steer
      ? async (text) => {
          const outcome = await process.channel.request<CursorOwnerSteer>("steer", { id, text });
          if (typeof outcome === "string") return outcome;
          return { outcome: "queued", run: outcome.run && remoteRun(process, outcome.run) };
        }
      : undefined,
  };
}

export async function openOwnedCursorExecution(
  store: LocalAgentStore,
  agentId: string,
  home: string,
  generation: string,
  enroll: EnrollExecutionOwner,
  bind: (runId: string) => Promise<void>,
) {
  let process: OwnedProcess | undefined;
  const storeOwner = serveCursorStore(
    store,
    agentId,
    () => process?.channel.connected === true,
    bind,
  );
  const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const entry = fileURLToPath(new URL(`./cursor-owner-worker.${suffix}`, import.meta.url));
  let answerQuestion: SDKCustomTool["execute"] | undefined;
  let speak: SDKCustomTool["execute"] | undefined;
  let onModelCall: ((usage: Pick<TokenUsage, "inputTokens" | "outputTokens">) => void) | undefined;
  const owned = await openOwnedProcess(entry, home, generation, enroll, async (method, input) => {
    if (method === "model_call_completed") {
      const payload = input as { usage?: Pick<TokenUsage, "inputTokens" | "outputTokens"> };
      if (payload?.usage) onModelCall?.(payload.usage);
      return;
    }
    if (method === "question" || method === "speak") {
      const handler = method === "question" ? answerQuestion : speak;
      if (!handler || !process?.channel.connected)
        throw new Error(`Cursor SDK ${method} handler is unavailable.`);
      const { args, context } = input as {
        args: Parameters<SDKCustomTool["execute"]>[0];
        context: Parameters<SDKCustomTool["execute"]>[1];
      };
      return handler(args, context);
    }
    return storeOwner.handle(method, input);
  });
  process = owned;
  let ending: Promise<void> | undefined;
  async function closeWriter() {
    try {
      await Promise.race([owned.channel.request("close"), delay(500, undefined, { ref: false })]);
    } catch {
      // Loss of the worker's reply cannot clear the durable owner guard.
    } finally {
      owned.channel.close();
      await storeOwner.close();
    }
  }

  return {
    attachQuestionHandler(execute: SDKCustomTool["execute"], abort: () => void) {
      answerQuestion = execute;
      void owned.channel.whenClosed.then(abort);
    },
    prepare: (input: CursorOwnerStart) => owned.channel.request<void>("prepare", input),
    attachSpeakHandler(execute: SDKCustomTool["execute"]) {
      speak = execute;
    },
    attachModelCallHandler(
      handler: (usage: Pick<TokenUsage, "inputTokens" | "outputTokens">) => void,
    ) {
      onModelCall = handler;
    },
    async send(input: SDKUserMessage | null): Promise<Run> {
      const info = await owned.channel.request<CursorOwnerRunInfo>("dispatch", {
        input,
        voice: speak !== undefined,
      });
      if (info.agentId !== agentId) throw new Error("Cursor SDK owner returned a different agent.");
      return remoteRun(owned, info);
    },
    async finish(waitForTools: boolean, cancelTools: boolean) {
      await (ending ??= closeWriter());
      if (cancelTools) await requestExecutionOwnerStop(owned.owner).catch(() => undefined);
      if (waitForTools) await owned.waitForExit();
    },
  };
}
