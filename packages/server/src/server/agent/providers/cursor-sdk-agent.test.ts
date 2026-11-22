import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import type { RunResult, SDKMessage, SDKModel, SDKUserMessage, SendOptions } from "@cursor/sdk";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDaemonTestContext } from "../../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { hasHeldMessages } from "../held-messages.js";
import { startAgentRun } from "../agent-prompt.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { clearUnusedCursorReservation, CursorSdkAgentClient } from "./cursor-sdk-agent.js";
import { listCursorSdkModels as listCursorModels } from "./cursor-sdk-availability.js";

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

const stores: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await rm(store, { recursive: true, force: true });
});

function fixture() {
  const modelList = vi.fn(async (_apiKey: string) => [model]);
  const storePath = mkdtempSync(join(tmpdir(), "paseo-cursor-adapter-"));
  stores.push(storePath);
  const cwd = realpathSync(process.cwd());
  const sdk = {
    JsonlLocalAgentStore: class {
      readonly agents = { get: async () => ({ agentId, cwd }) };
      readonly runs = { get: vi.fn(), list: async () => ({ items: [] }) };
    },
    Agent: {
      create: vi.fn(),
      resume: vi.fn(),
      messages: { list: vi.fn().mockResolvedValue([]) },
    },
  };
  const send = vi.fn<(_message: SDKUserMessage, _options: SendOptions) => Promise<unknown>>();
  const agent = { agentId, send, [Symbol.asyncDispose]: vi.fn(async () => {}) };
  sdk.Agent.create.mockResolvedValue(agent);
  sdk.Agent.resume.mockResolvedValue(agent);
  const load = vi.fn(async () => sdk) as unknown as NonNullable<
    ConstructorParameters<typeof CursorSdkAgentClient>[1]
  >;
  const client = new CursorSdkAgentClient(
    { env: { CURSOR_API_KEY: "test-key" } },
    load,
    modelList,
    undefined,
    storePath,
  );
  const config: AgentSessionConfig = { provider, cwd: process.cwd(), model: "model" };
  return { client, config, sdk, load, send, modelList, storePath, agent };
}

describe("Cursor SDK provider", () => {
  it("lists commands from a daemon launched with inherited agent identity", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "launcher-agent");
    vi.stubEnv("PASEO_AGENT_CWD", "/launcher-workspace");
    vi.stubEnv("PASEO_WORKSPACE_ID", "launcher-workspace");
    const { client: cursorClient, sdk, send } = fixture();
    const onLaunchContext = vi.fn();
    try {
      const ctx = await createDaemonTestContext({
        providerOverrides: { [provider]: { enabled: true } },
        agentClients: {
          ...createTestAgentClients({ onLaunchContext }),
          [provider]: cursorClient,
        },
      });
      try {
        const cwd = await realpath(ctx.daemon.paseoHome);
        const draft = { provider, cwd, model: model.id };
        const commands = await ctx.client.listCommands({
          agentId: "__new_agent__",
          draftConfig: draft,
        });
        expect(commands).toMatchObject({ commands: [], error: null });
        expect(sdk.Agent.create).not.toHaveBeenCalled();

        const { workspace } = await ctx.client.createWorkspace({
          source: { kind: "directory", path: cwd },
          title: "Isolated command discovery",
        });
        if (!workspace) throw new Error("Failed to create test workspace");
        const cursor = await ctx.client.createAgent({ ...draft, workspaceId: workspace.id });
        expect(sdk.Agent.create).toHaveBeenCalledOnce();
        await expect(ctx.client.listCommands({ agentId: cursor.id })).resolves.toMatchObject({
          commands: [],
          error: null,
        });
        expect(send).not.toHaveBeenCalled();

        const managed = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          workspaceId: workspace.id,
        });
        expect(onLaunchContext).toHaveBeenCalledWith(
          expect.objectContaining({
            env: expect.objectContaining({
              PASEO_AGENT_ID: managed.id,
              PASEO_AGENT_CWD: cwd,
              PASEO_WORKSPACE_ID: workspace.id,
            }),
          }),
          expect.anything(),
        );
        expect(process.env.PASEO_AGENT_ID).toBeUndefined();
        expect(process.env.PASEO_AGENT_CWD).toBeUndefined();
        expect(process.env.PASEO_WORKSPACE_ID).toBeUndefined();
      } finally {
        await ctx.cleanup();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires a credential before opening an agent", async () => {
    vi.stubEnv("CURSOR_API_KEY", "");
    try {
      const { config, load } = fixture();
      const client = new CursorSdkAgentClient(undefined, load, undefined, async () => undefined);
      const manager = new AgentManager({
        clients: { [provider]: client },
        logger: pino({ level: "silent" }),
      });
      await expect(
        manager.createAgent(config, undefined, { workspaceId: undefined }),
      ).rejects.toThrow("Sign in to Cursor SDK");
      await expect(client.createSession(config)).rejects.toThrow("Sign in to Cursor SDK");
      expect(load).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a new stored sign-in for discovery, create, and resume on the same client", async () => {
    vi.stubEnv("CURSOR_API_KEY", "");
    try {
      let storedKey: string | undefined;
      const { config, load, modelList, sdk } = fixture();
      const client = new CursorSdkAgentClient(undefined, load, modelList, async () => storedKey);
      await expect(client.isAvailable()).rejects.toThrow("Sign in to Cursor SDK");
      storedKey = "stored-key";
      expect(await client.isAvailable()).toBe(true);
      const session = await client.createSession(config);
      expect(modelList).toHaveBeenCalledWith(storedKey, expect.any(AbortSignal));
      expect(sdk.Agent.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: storedKey }));
      await session.close();
      storedKey = "new-stored-key";
      const resumed = await client.resumeSession({
        provider,
        sessionId: agentId,
        metadata: { cwd: config.cwd },
      });
      expect(sdk.Agent.resume).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ apiKey: storedKey }),
      );
      await resumed.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["stop", "rotate"] as const)(
    "rejects dispatch when %s occurs during native credential rebinding",
    async (change) => {
      vi.stubEnv("CURSOR_API_KEY", "");
      const { config, load, modelList, sdk, agent, send, storePath } = fixture();
      const enteredResume = Promise.withResolvers<void>();
      const releaseResume = Promise.withResolvers<void>();
      const replacementSend = vi
        .fn()
        .mockResolvedValue(makeRun([], { id: runId, status: "finished" }));
      const rebound = { ...agent, send: replacementSend };
      let key: string | undefined = "original";
      const client = new CursorSdkAgentClient(
        undefined,
        load,
        modelList,
        async () => key,
        storePath,
      );
      const session = await client.createSession(config);
      try {
        key = undefined;
        await expect(session.startTurn("signed out")).rejects.toThrow("Sign in to Cursor SDK");
        await session.interrupt();
        expect(send).not.toHaveBeenCalled();

        key = "replacement";
        sdk.Agent.resume
          .mockImplementationOnce(async () => {
            enteredResume.resolve();
            await releaseResume.promise;
            return rebound;
          })
          .mockResolvedValue(rebound);
        const start = session.startTurn("blocked dispatch");
        void start.catch(() => {});
        await Promise.race([enteredResume.promise, start]);
        expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
        const stop = change === "stop" ? session.interrupt() : undefined;
        if (change === "rotate") key = "latest";
        releaseResume.resolve();
        await expect(start).rejects.toThrow(
          change === "stop" ? "stopped before dispatch" : "sign-in changed",
        );
        await (stop ?? session.interrupt());
        expect(send).not.toHaveBeenCalled();
        expect(replacementSend).not.toHaveBeenCalled();
        expect(session.describePersistence()?.nativeHandle).toBe(agentId);
        expect(sdk.Agent.resume).toHaveBeenCalledWith(
          agentId,
          expect.objectContaining({ apiKey: "replacement" }),
        );
        await session.run("retry after credentials settle");
        expect(replacementSend).toHaveBeenCalledOnce();
        if (change === "rotate") {
          expect(sdk.Agent.resume).toHaveBeenLastCalledWith(
            agentId,
            expect.objectContaining({ apiKey: "latest" }),
          );
        }
      } finally {
        releaseResume.resolve();
        await session.close();
        vi.unstubAllEnvs();
      }
    },
  );

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

  it("uses the final result for terminal status and replays the same ordered tool updates", async () => {
    const { client, config, send } = fixture();
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
      ...live,
      { type: "assistant_message", text: `[System Error] ${error.message}\n\ncode: ${error.code}` },
    ]);
    await session.close();
  });

  it("records CLI and desktop prompts once when Cursor omits user events, including after resume", async () => {
    const { client, config, sdk, send } = fixture();
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
    const live = await manager.getTimelineRows(agent.id);
    expect(live.map(({ item }) => item)).toEqual([
      { type: "user_message", text: prompt, messageId: expect.stringMatching(/:user$/) },
      { type: "assistant_message", text: "first answer" },
      { type: "user_message", text: prompt, clientMessageId: "ui-prompt", messageId: "ui-prompt" },
      { type: "assistant_message", text: "second answer" },
    ]);
    await manager.closeAgent(agent.id);

    const session = await client.resumeSession(
      { provider, sessionId: agentId, metadata: { cwd: config.cwd } },
      config,
      undefined,
      { purpose: "history" },
    );
    const history = (await Array.fromAsync(session.streamHistory())).flatMap((event) =>
      event.type === "timeline" ? [[event.turnId, event.item]] : [],
    );
    expect(history).toEqual(live.map(({ turnId, item }) => [turnId, item]));
    expect(sdk.Agent.resume).not.toHaveBeenCalled();
    await session.close();
  });

  it("blocks a replacement until both the cancel request and local SDK controller settle", async () => {
    const { client, config, send } = fixture();
    const started = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    const executionSettled = Promise.withResolvers<void>();
    const result = { id: runId, status: "cancelled" } satisfies RunResult;
    const tool = {
      ...eventIds,
      type: "tool_call",
      call_id: "active",
      name: "read",
      status: "running",
      args: { path: "test.txt" },
    } satisfies SDKMessage;
    const cancelled = { ...eventIds, type: "status", status: "CANCELLED" } satisfies SDKMessage;
    const thinking = { ...eventIds, type: "thinking", text: "Run the shell" } satisfies SDKMessage;
    const run = {
      ...makeRun([], result),
      status: "running",
      stream: async function* () {
        yield thinking;
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
      name: "read",
      status: "running",
      error: null,
      detail: { type: "unknown", input: tool.args, output: null },
    };
    const canceledTool = { ...running, status: "canceled" };
    expect(
      live.map((item) => AgentTimelineItemPayloadSchema.parse(JSON.parse(JSON.stringify(item)))),
    ).toEqual([
      { type: "user_message", text: "first", messageId: expect.stringMatching(/:user$/) },
      { type: "reasoning", text: thinking.text },
      running,
      canceledTool,
    ]);
    const replay = await Array.fromAsync(session.streamHistory());
    const turnId = events.find((event) => event.type === "turn_started")?.turnId;
    expect(replay).toEqual(
      live.map((item) => ({
        type: "timeline",
        provider,
        turnId,
        timestamp: expect.any(String),
        item,
      })),
    );
    await session.run("replacement");
    expect(send.mock.calls.map(([prompt]) => prompt.text)).toEqual(["first", "replacement"]);
    await session.close();
  });
  it("keeps an explicit Queue held when native join cannot confirm Stop", async () => {
    const { client, config, send } = fixture();
    const logger = pino({ level: "silent" });
    const manager = new AgentManager({
      clients: { [provider]: client },
      logger,
      rescueTimeouts: { interruptSessionMs: 100 },
    });
    const release = Promise.withResolvers<void>();
    const run = {
      ...makeRun([], { id: runId, status: "cancelled" }),
      status: "running",
      stream: async function* () {
        await release.promise;
        yield { ...eventIds, type: "status", status: "CANCELLED" } satisfies SDKMessage;
      },
      cancel: async () => release.resolve(),
      wait: async () => {
        throw new Error("SDK failed to join the tool controller");
      },
    };
    send.mockResolvedValue(run);
    const agent = await manager.createAgent(config, undefined, { workspaceId: undefined });
    await expect(startAgentRun(manager, agent.id, "first", logger)).resolves.toMatchObject({
      disposition: "turn_started",
    });
    await manager.waitForAgentRunStart(agent.id);
    expect(send).toHaveBeenCalledOnce();
    await expect(
      startAgentRun(manager, agent.id, "explicit queue", logger, {
        activeTurnBehavior: "queue",
      }),
    ).resolves.toMatchObject({ disposition: "queued" });
    expect((await manager.cancelAgentRun(agent.id)).status).toBe("refused");
    expect(manager.hasInFlightRun(agent.id)).toBe(true);
    expect(hasHeldMessages(manager, agent.id)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
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
