import { Console } from "node:console";
import type { AgentOptions, Run, SDKAgent, SDKMessage, SDKUserMessage } from "@cursor/sdk";
import { withCursorShellEnvironment } from "../providers/cursor-sdk-shell-environment.js";
import { loadCursorSdk } from "../providers/cursor-sdk-loader.js";
import {
  cursorQuestionToolDescriptor,
  cursorQuestionToolName,
} from "../providers/cursor-sdk-questions.js";
import { cursorSpeakToolDescriptor, cursorSpeakToolName } from "../providers/cursor-sdk-voice.js";
import { proxyCursorStore } from "./cursor-store-proxy.js";
import { ownerDeferred } from "./owner-channel.js";
import { connectOwnedProcess } from "./owned-process.js";

type RunOperation = Parameters<Run["supports"]>[0];

export interface CursorOwnerStart {
  agentId: string;
  options: Omit<AgentOptions, "local"> & {
    local: Omit<NonNullable<AgentOptions["local"]>, "store">;
  };
  env: NodeJS.ProcessEnv;
  shellEnvironment: Parameters<typeof withCursorShellEnvironment>[0];
}

export interface CursorOwnerRunInfo {
  id: string;
  agentId: string;
  status: Run["status"];
  operations: RunOperation[];
  steer: boolean;
}

export type CursorOwnerSteer =
  | "complete_delivered"
  | "revert_to_followup"
  | { outcome: "queued"; run?: CursorOwnerRunInfo };

async function main() {
  let agent: SDKAgent | undefined;
  let started = false;
  let model: AgentOptions["model"];
  let dispatched = false;
  let shellEnvironment: CursorOwnerStart["shellEnvironment"];
  const runs = new Map<string, Run>();
  const streams = new Map<string, AsyncGenerator<SDKMessage, void>>();
  const channelReady = ownerDeferred<Awaited<ReturnType<typeof connectOwnedProcess>>>();

  function describe(run: Run): CursorOwnerRunInfo {
    runs.set(run.id, run);
    const operations: RunOperation[] = ["stream", "wait", "cancel", "conversation"];
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      operations: operations.filter((operation) => run.supports(operation)),
      steer: typeof run.steer === "function",
    };
  }

  async function start(value: unknown, channel: Awaited<typeof channelReady.promise>) {
    if (started) throw new Error("Cursor SDK owner already started a run.");
    started = true;
    const session = value as CursorOwnerStart;
    const { agentId, options, env } = session;
    model = options.model;
    shellEnvironment = session.shellEnvironment;
    if (options.local.cwd) process.chdir(options.local.cwd);
    for (const name of Object.keys(process.env)) delete process.env[name];
    for (const [name, entry] of Object.entries(env)) {
      if (entry !== undefined) process.env[name] = entry;
    }
    const { Agent } = await loadCursorSdk();
    if (!channel.connected) throw new Error("Cursor SDK owner disconnected before opening.");
    const store = proxyCursorStore(channel.request);
    return withCursorShellEnvironment(shellEnvironment, async () => {
      agent = await Agent.resume(agentId, { ...options, local: { ...options.local, store } });
      if (!channel.connected) throw new Error("Cursor SDK owner disconnected while opening.");
    });
  }

  async function handle(method: string, value: unknown): Promise<unknown> {
    const channel = await channelReady.promise;
    if (!channel.connected) throw new Error("Cursor SDK owner disconnected.");
    if (method === "prepare") return start(value, channel);
    if (method === "dispatch") {
      if (!agent || dispatched) throw new Error("Cursor SDK owner has no pending dispatch.");
      dispatched = true;
      const native = agent;
      const { input, voice } = value as { input: SDKUserMessage | null; voice: boolean };
      if (input === null) {
        return withCursorShellEnvironment(shellEnvironment, async () =>
          describe(await native.summarize()),
        );
      }
      return withCursorShellEnvironment(shellEnvironment, async () =>
        describe(
          await native.send(input, {
            model,
            onDelta: async ({ update }) => {
              if (update.type !== "model-call-completed" || !channel.connected) return;
              await channel
                .request("model_call_completed", {
                  modelCallId: update.modelCallId,
                  usage: update.usage,
                })
                .catch(() => {});
            },
            local: {
              customTools: {
                [cursorQuestionToolName]: {
                  ...cursorQuestionToolDescriptor,
                  execute: (args, context) => channel.request("question", { args, context }),
                },
                ...(voice
                  ? {
                      [cursorSpeakToolName]: {
                        ...cursorSpeakToolDescriptor,
                        execute: (args, context) => channel.request("speak", { args, context }),
                      },
                    }
                  : {}),
              },
            },
          }),
        ),
      );
    }
    if (method === "close") {
      await agent?.[Symbol.asyncDispose]();
      return;
    }
    const { id, text } = value as { id: string; text?: string };
    const run = runs.get(id);
    if (!run) throw new Error("The Cursor SDK owner does not have this run.");
    switch (method) {
      case "next": {
        let stream = streams.get(id);
        if (!stream) {
          stream = run.stream();
          streams.set(id, stream);
        }
        return stream.next();
      }
      case "wait":
        return run.wait();
      case "cancel":
        await run.cancel();
        return run.status;
      case "conversation":
        return run.conversation();
      case "steer": {
        if (!run.steer || typeof text !== "string") throw new Error("Steering unavailable.");
        const steer = run.steer.bind(run);
        const outcome = await withCursorShellEnvironment(shellEnvironment, () => steer(text));
        if (typeof outcome === "string") return outcome;
        return {
          outcome: "queued",
          run: outcome.run && describe(outcome.run),
        } satisfies CursorOwnerSteer;
      }
      default:
        throw new Error("Unknown Cursor SDK owner operation.");
    }
  }

  const channel = await connectOwnedProcess(handle);
  channelReady.resolve(channel);
  // The daemon owns the store and the right to dispatch. Its lost connection
  // fences further work. Descendants still alive remain visible in the cgroup.
  channel.whenClosed.then(() => process.exit(0)).catch(() => process.exit(1));
}

// Stdout is a private framed pipe. SDK diagnostics are never sent on it.
globalThis.console = new Console(process.stderr);
await main();
