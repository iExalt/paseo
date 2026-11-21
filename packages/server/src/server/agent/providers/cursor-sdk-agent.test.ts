import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import type { RunResult, SDKMessage, SDKModel, SDKUserMessage, SendOptions } from "@cursor/sdk";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AgentManager } from "../agent-manager.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import {
  clearUnusedCursorReservation,
  CursorSdkAgentClient,
  listCursorModels,
} from "./cursor-sdk-agent.js";

const provider = "cursor-sdk";
const agentId = "agent-test";
const runId = "run-test";
const eventIds = { agent_id: agentId, run_id: runId };
const model: SDKModel = {
  id: "model",
  displayName: "Cursor Test Model",
  parameters: [
    {
      id: "reasoning",
      displayName: "Reasoning",
      values: [{ value: "low" }, { value: "high", displayName: "High" }],
    },
  ],
  variants: [{ params: [{ id: "reasoning", value: "low" }], displayName: "Low", isDefault: true }],
};

function makeRun(messages: SDKMessage[], result: RunResult, createdAt = Date.UTC(2026, 10, 21)) {
  return {
    id: result.id,
    createdAt,
    status: result.status,
    supports: () => true,
    stream: async function* () {
      yield* messages;
    },
    wait: vi.fn(async () => result),
    cancel: vi.fn(async () => {}),
  };
}

function fixture() {
  const modelList = vi.fn(async (_apiKey: string) => [model]);
  const getRun = vi.fn();
  const sdk = {
    JsonlLocalAgentStore: class {
      readonly agents = { get: async () => null };
      readonly runs = { get: getRun };
    },
    Agent: {
      create: vi.fn(),
      resume: vi.fn(),
      listRuns: vi.fn(),
      messages: { list: vi.fn().mockResolvedValue([]) },
    },
  };
  const send = vi.fn<(_message: SDKUserMessage, _options: SendOptions) => Promise<unknown>>();
  const agent = { agentId, send, [Symbol.asyncDispose]: vi.fn(async () => {}) };
  sdk.Agent.create.mockResolvedValue(agent);
  sdk.Agent.resume.mockResolvedValue(agent);
  sdk.Agent.listRuns.mockResolvedValue({ items: [] });
  const load = vi.fn(async () => sdk) as unknown as NonNullable<
    ConstructorParameters<typeof CursorSdkAgentClient>[1]
  >;
  const client = new CursorSdkAgentClient({ env: { CURSOR_API_KEY: "test-key" } }, load, modelList);
  const config: AgentSessionConfig = { provider, cwd: process.cwd(), model: "model" };
  return { client, config, sdk, load, send, modelList, getRun };
}

describe("Cursor SDK provider", () => {
  it("requires its daemon credential without loading the SDK or changing process.env", async () => {
    const before = process.env.CURSOR_API_KEY;
    const { config, load } = fixture();
    const client = new CursorSdkAgentClient({ env: { CURSOR_API_KEY: "" } }, load);
    const manager = new AgentManager({
      clients: { [provider]: client },
      logger: pino({ level: "silent" }),
    });
    await expect(
      manager.createAgent(config, undefined, { workspaceId: undefined }),
    ).rejects.toThrow("Cursor SDK requires CURSOR_API_KEY");
    await expect(client.createSession(config)).rejects.toThrow("Set it in the daemon environment");
    expect(load).not.toHaveBeenCalled();
    expect(process.env.CURSOR_API_KEY).toBe(before);
  });

  it("rejects other modes and cloud handles before opening the SDK agent", async () => {
    const { client, config, load } = fixture();
    const handle = { provider, sessionId: agentId, metadata: { cwd: config.cwd } };
    const otherMode = { ...config, modeId: "sandboxed" };
    await expect(client.createSession(otherMode)).rejects.toThrow("only Unrestricted mode");
    await expect(client.resumeSession(handle, otherMode)).rejects.toThrow("only Unrestricted mode");
    await expect(
      client.resumeSession({ ...handle, sessionId: "bc-cloud" }, config),
    ).rejects.toThrow("saved local agent");
    expect(load).not.toHaveBeenCalled();
  });

  it("discovers model parameters and reapplies effective MCP, instructions and selections after a resume", async () => {
    const { client, config, sdk, send, modelList } = fixture();
    const catalog = await client.fetchCatalog({ scope: "global", force: true });
    expect(catalog.models).toEqual([
      {
        provider,
        id: "model",
        label: "Cursor Test Model",
        isDefault: false,
        metadata: { parameters: model.parameters, variants: model.variants },
      },
    ]);
    expect(modelList).toHaveBeenCalledExactlyOnceWith("test-key", expect.any(AbortSignal));
    const cwd = await realpath(config.cwd);
    const configured = {
      ...config,
      providerOptions: { cursor_model_reasoning: "high" },
      systemPrompt: "Project instructions",
      daemonAppendSystemPrompt: "Daemon instructions",
      mcpServers: { configured: { type: "http", url: "http://127.0.0.1/configured" } },
    } satisfies AgentSessionConfig;
    const launch = { mcpServers: { runtime: { type: "stdio" as const, command: "runtime-mcp" } } };
    const session = await client.createSession(configured, launch);
    expect(sdk.Agent.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        local: expect.objectContaining({ sandboxOptions: { enabled: false }, autoReview: false }),
      }),
    );
    expect(await session.getCurrentMode()).toBe("unrestricted");
    const handle = session.describePersistence()!;
    expect(handle).toEqual({
      provider,
      sessionId: agentId,
      nativeHandle: agentId,
      metadata: { cwd },
    });
    await session.close();
    const resumed = await client.resumeSession(
      handle,
      { ...configured, daemonAppendSystemPrompt: "Updated" },
      launch,
    );
    expect(sdk.Agent.resume).toHaveBeenCalledExactlyOnceWith(
      agentId,
      expect.objectContaining({
        apiKey: "test-key",
        local: expect.objectContaining({
          cwd,
          sandboxOptions: { enabled: false },
          autoReview: false,
          settingSources: [],
        }),
        mcpServers: { ...configured.mcpServers, ...launch.mcpServers },
        model: { id: "model", params: [{ id: "reasoning", value: "high" }] },
      }),
    );
    expect(sdk.Agent.resume.mock.calls[0][1]).not.toHaveProperty("systemPrompt");
    expect(resumed.controls).toEqual([
      {
        type: "select",
        key: "cursor_model_reasoning",
        label: "Reasoning",
        defaultValue: "low",
        choices: [
          { label: "low", value: "low" },
          { label: "High", value: "high" },
        ],
      },
    ]);
    send.mockResolvedValue(makeRun([], { id: runId, status: "finished", result: "answer" }));
    await resumed.run("a follow-up");
    expect(send).toHaveBeenCalledExactlyOnceWith(
      {
        text: "<paseo_instructions>\nProject instructions\n\nUpdated\n</paseo_instructions>\n\na follow-up",
      },
      { model: { id: "model", params: [{ id: "reasoning", value: "high" }] } },
    );
    await resumed.close();
  });

  it("uses the final result for terminal status and replays a tool only once", async () => {
    const { client, config, sdk, send } = fixture();
    const messages = [
      {
        ...eventIds,
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "prompt" }] },
      },
      { ...eventIds, type: "thinking", text: "reason" },
      {
        ...eventIds,
        type: "tool_call",
        call_id: "call",
        name: "shell",
        status: "running",
        args: { command: "pwd" },
      },
      {
        ...eventIds,
        type: "tool_call",
        call_id: "call",
        name: "shell",
        status: "completed",
        result: "done",
      },
      {
        ...eventIds,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
      { ...eventIds, type: "status", status: "FINISHED" },
    ] satisfies SDKMessage[];
    const error = { message: "Final failure", code: "bad_run" };
    const run = makeRun(messages, { id: runId, status: "error", error });
    sdk.Agent.listRuns
      .mockResolvedValueOnce({ items: [run], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [run] });
    send.mockResolvedValue(run);
    const session = await client.createSession(config);
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await expect(session.run("prompt")).rejects.toThrow(error.message);
    expect(
      events.filter((event) => event.type.startsWith("turn_")).map((event) => event.type),
    ).toEqual(["turn_started", "turn_failed"]);
    expect(events.at(-1)).toMatchObject({
      type: "turn_failed",
      error: error.message,
      code: error.code,
    });
    const live = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    expect(live.map((item) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(live[3]).toMatchObject({
      callId: runId + ":call",
      status: "completed",
      detail: { input: { command: "pwd" }, output: "done" },
    });
    const replay = (await Array.fromAsync(session.streamHistory())).flatMap((event) =>
      event.type === "timeline" ? [event.item] : [],
    );
    expect(replay).toEqual([
      ...live.filter((item) => item.type !== "tool_call" || item.status !== "running"),
      { type: "error", message: error.message },
    ]);
    expect(sdk.Agent.listRuns).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it("records CLI and desktop prompts once when Cursor omits user events, including after resume", async () => {
    const { client, config, sdk, send, getRun } = fixture();
    const manager = new AgentManager({
      clients: { [provider]: client },
      logger: pino({ level: "silent" }),
    });
    const prompt = "Repeat this prompt";
    const first = makeRun([], { id: "first", status: "finished", result: "first answer" }, 1000);
    const second = makeRun([], { id: "second", status: "finished", result: "second answer" }, 2000);
    send.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const agent = await manager.createAgent(
      { ...config, systemPrompt: "Do not show this instruction" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.runAgent(agent.id, prompt);
    await manager.runAgent(agent.id, prompt, { clientMessageId: "ui-prompt" });
    expect(manager.getTimeline(agent.id)).toEqual([
      { type: "user_message", text: prompt },
      { type: "assistant_message", text: "first answer" },
      { type: "user_message", text: prompt, clientMessageId: "ui-prompt", messageId: "ui-prompt" },
      { type: "assistant_message", text: "second answer" },
    ]);
    await manager.closeAgent(agent.id);

    sdk.Agent.listRuns.mockResolvedValue({ items: [second, first] });
    sdk.Agent.messages.list.mockResolvedValue(
      [first, second].map((run, index) => ({
        type: "user",
        message: {
          turn: {
            case: "agentConversationTurn",
            value: {
              userMessage: {
                text: send.mock.calls[index][0].text,
                messageId: "native-" + run.id,
                startedAtMs: BigInt(run.createdAt + 10),
              },
            },
          },
        },
      })),
    );
    getRun.mockImplementation(async ({ runId: id }) => {
      const run = id === first.id ? first : second;
      return {
        createdAt: run.createdAt,
        startedAt: run.createdAt + 1,
        endedAt: run.createdAt + 100,
      };
    });
    const session = await client.resumeSession(
      { provider, sessionId: agentId, metadata: { cwd: config.cwd } },
      config,
      undefined,
      { purpose: "history" },
    );
    const history = (await Array.fromAsync(session.streamHistory())).flatMap((event) =>
      event.type === "timeline" ? [[event.turnId, event.item]] : [],
    );
    expect(history).toEqual([
      [first.id, { type: "user_message", text: prompt, messageId: "native-first" }],
      [first.id, { type: "assistant_message", text: "first answer" }],
      [second.id, { type: "user_message", text: prompt, messageId: "native-second" }],
      [second.id, { type: "assistant_message", text: "second answer" }],
    ]);
    await session.close();
  });

  it("blocks a replacement until both the cancel request and local SDK controller settle", async () => {
    const { client, config, sdk, send } = fixture();
    const started = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    const executionSettled = Promise.withResolvers<void>();
    const result = { id: runId, status: "cancelled" } satisfies RunResult;
    const tool = {
      ...eventIds,
      type: "tool_call",
      call_id: "active",
      name: "shell",
      status: "running",
      args: { command: "sleep 60", timeout: 120_000 },
    } satisfies SDKMessage;
    const cancelled = { ...eventIds, type: "status", status: "CANCELLED" } satisfies SDKMessage;
    sdk.Agent.listRuns.mockResolvedValue({ items: [makeRun([tool, cancelled], result)] });
    const run = {
      ...makeRun([], result),
      status: "running",
      stream: async function* () {
        yield tool;
        started.resolve();
        await canceled.promise;
        yield cancelled;
      },
      cancel: async () => canceled.resolve(),
      wait: async () => {
        await executionSettled.promise;
        return result;
      },
    };
    send
      .mockResolvedValueOnce(run)
      .mockResolvedValue(makeRun([], { id: "next", status: "finished" }));
    const session = await client.createSession(config);
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.run("first");
    await started.promise;
    const stop = session.interrupt();
    await canceled.promise;
    await expect(session.startTurn("too early")).rejects.toThrow("still running or stopping");
    executionSettled.resolve();
    const output = await turn;
    expect(output.canceled).toBe(true);
    await stop;
    const live = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    const running = {
      type: "tool_call",
      callId: runId + ":active",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "unknown", input: tool.args, output: null },
    };
    const canceledTool = { ...running, status: "canceled" };
    expect(
      live.map((item) => AgentTimelineItemPayloadSchema.parse(JSON.parse(JSON.stringify(item)))),
    ).toEqual([{ type: "user_message", text: "first" }, running, canceledTool]);
    const replay = JSON.parse(JSON.stringify(await Array.fromAsync(session.streamHistory())));
    expect(replay).toEqual([
      {
        type: "timeline",
        provider,
        turnId: runId,
        timestamp: "2026-11-21T00:00:00.000Z",
        item: canceledTool,
      },
    ]);
    await session.run("replacement");
    expect(send.mock.calls.map(([prompt]) => prompt.text)).toEqual(["first", "replacement"]);
    await session.close();
  });
});

it("aborts a stalled model catalog worker", async () => {
  const name = "cursor-sdk-model-test-" + crypto.randomUUID();
  const channel = new BroadcastChannel(name);
  const controller = new AbortController();
  const started = Promise.withResolvers<unknown>();
  channel.addEventListener("message", (event) => started.resolve(event.data), { once: true });
  const sdk = `import { BroadcastChannel } from "node:worker_threads";
    export const Cursor = { models: { list: async ({ apiKey }) => {
      const channel = new BroadcastChannel(${JSON.stringify(name)});
      channel.postMessage(apiKey);
      return new Promise(() => {});
    } } };`;
  const result = listCursorModels(
    "fake-credential",
    controller.signal,
    "data:text/javascript," + encodeURIComponent(sdk),
  );
  try {
    await expect(started.promise).resolves.toBe("fake-credential");
    controller.abort(new Error("catalog deadline"));
    await expect(result).rejects.toThrow("catalog deadline");
  } finally {
    channel.close();
    controller.abort();
  }
});

it("clears an SDK first turn reservation on interactive resume without clearing a later run", async () => {
  const { Agent, JsonlLocalAgentStore, createAgentPlatform } = await import("@cursor/sdk");
  const root = await mkdtemp(join(tmpdir(), "paseo-cursor-reservation-"));
  try {
    const cwd = await realpath(root);
    const storeDir = join(cwd, "store");
    await mkdir(storeDir);
    const store = new JsonlLocalAgentStore(storeDir);
    const local = { cwd, store };
    const agent = await Agent.create({ local });
    await agent[Symbol.asyncDispose]();
    const id = agent.agentId;
    const platform = await createAgentPlatform({ localStore: store, workspaceRef: cwd });
    await expect(platform.store.createFollowUpRun(id, {})).rejects.toThrow(
      "already has active run",
    );
    const reserved = (await store.runs.list({ filter: { agentIds: [id] } })).items[0];
    await clearUnusedCursorReservation(Agent, store, id, cwd);
    expect((await store.runs.get({ agentId: id, runId: reserved.runId }))?.status).toBe(
      "cancelled",
    );
    const resumed = await Agent.resume(id, { local });
    expect(resumed.agentId).toBe(id);
    const next = await platform.store.createFollowUpRun(id, {});
    await clearUnusedCursorReservation(Agent, store, id, cwd);
    expect((await store.agents.get({ agentId: id }))?.activeRunId).toBe(next.runId);
    await resumed[Symbol.asyncDispose]();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
