import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import type { RunResult, SDKMessage, SDKModel, SDKUserMessage, SendOptions } from "@cursor/sdk";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDaemonTestContext } from "../../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { openOwnedCursorExecution } from "../execution-owner/cursor-owned-execution.js";
import { supportsExecutionOwner } from "../execution-owner/execution-owner.js";
import { hasHeldMessages } from "../held-messages.js";
import { startAgentRun } from "../agent-prompt.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { CursorQuestions } from "./cursor-sdk-questions.js";
import { CursorTurnJournal, type CursorHistoryTurn } from "./cursor-sdk-turn-journal.js";
import { clearUnusedCursorReservation, CursorSdkAgentClient } from "./cursor-sdk-agent.js";
import { listCursorSdkModels as listCursorModels } from "./cursor-sdk-availability.js";

vi.mock("../execution-owner/execution-owner.js", async (load) => ({
  ...(await load<typeof import("../execution-owner/execution-owner.js")>()),
  supportsExecutionOwner: vi.fn(async () => false),
}));
vi.mock("../execution-owner/cursor-owned-execution.js", () => ({
  openOwnedCursorExecution: vi.fn(),
}));

const assertMockLaunchAvailable = () => {};

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
  vi.mocked(supportsExecutionOwner).mockReset();
  vi.mocked(openOwnedCursorExecution).mockReset();
  for (const store of stores.splice(0)) await rm(store, { recursive: true, force: true });
});

function fixture(initialReservation?: string) {
  const modelList = vi.fn(async (_apiKey: string) => [model]);
  const storePath = mkdtempSync(join(tmpdir(), "paseo-cursor-adapter-"));
  stores.push(storePath);
  const cwd = realpathSync(process.cwd());
  let reservation = initialReservation;
  const sdk = {
    JsonlLocalAgentStore: class {
      readonly agents = { get: async () => ({ agentId, cwd, activeRunId: reservation }) };
      readonly runs = {
        get: vi.fn(async () =>
          reservation ? { runId: reservation, turnNumber: 1, status: "queued" } : undefined,
        ),
        list: async () => ({ items: [] }),
      };
    },
    Agent: {
      create: vi.fn(),
      resume: vi.fn(),
      cancelRun: vi.fn(async () => {
        reservation = undefined;
      }),
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
  it("reuses the direct agent if an available execution owner fails enrollment", async () => {
    const { client, config, sdk, send, agent } = fixture();
    vi.mocked(supportsExecutionOwner).mockResolvedValueOnce(true);
    vi.mocked(openOwnedCursorExecution).mockRejectedValueOnce(new Error("Owner did not enroll."));
    send.mockResolvedValueOnce(makeRun([], { id: runId, status: "finished" }));
    const session = await client.createSession(config);
    try {
      await session.run("Use the original direct session");
      expect(openOwnedCursorExecution).toHaveBeenCalledOnce();
      expect(agent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(sdk.Agent.resume).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it("joins an enrolled owner if disposing the direct agent fails before dispatch", async () => {
    const { client, config, sdk, send, agent, storePath } = fixture();
    const finish = vi.fn(async () => {});
    const prepare = vi.fn();
    const ownedSend = vi.fn();
    vi.mocked(supportsExecutionOwner).mockResolvedValueOnce(true);
    vi.mocked(openOwnedCursorExecution).mockImplementationOnce(
      async (_, __, ___, generation, enroll) => {
        await enroll(
          {
            backend: "windows-job",
            generation,
            hostId: "a".repeat(64),
            receipt: join(storePath, "not-written"),
          },
          assertMockLaunchAvailable,
        );
        return { finish, prepare, send: ownedSend };
      },
    );
    agent[Symbol.asyncDispose].mockRejectedValueOnce(new Error("Direct disposal failed."));
    const session = await client.createSession(config);
    try {
      await expect(session.run("Do not dispatch")).rejects.toThrow("Direct disposal failed.");
      await vi.waitFor(() => expect(finish).toHaveBeenCalledExactlyOnceWith(true, false));
      expect(prepare).not.toHaveBeenCalled();
      expect(ownedSend).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(sdk.Agent.resume).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("can retry after clearing the first SDK reservation fails before owner admission", async () => {
    const { client, config, sdk, send, agent, storePath } = fixture("unused-reservation");
    sdk.Agent.cancelRun.mockRejectedValueOnce(new Error("Reservation could not be cleared."));
    vi.mocked(supportsExecutionOwner).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const abandoned = vi.fn();
    const attachQuestionHandler = vi.fn();
    const prepare = vi.fn(async () => {});
    const ownedSend = vi.fn().mockResolvedValue(makeRun([], { id: runId, status: "finished" }));
    vi.mocked(openOwnedCursorExecution).mockImplementation(
      async (_, __, ___, generation, enroll) => {
        try {
          await enroll(
            {
              backend: "windows-job",
              generation,
              hostId: "a".repeat(64),
              receipt: join(storePath, "not-written"),
            },
            assertMockLaunchAvailable,
          );
        } catch (error) {
          abandoned();
          throw error;
        }
        return {
          attachQuestionHandler,
          attachSpeakHandler: vi.fn(),
          attachModelCallHandler: vi.fn(),
          finish: async () => {},
          prepare,
          send: ownedSend,
        };
      },
    );
    const session = await client.createSession(config);
    try {
      await expect(session.run("First attempt")).rejects.toThrow(
        "Reservation could not be cleared.",
      );
      expect(abandoned).toHaveBeenCalledOnce();
      expect(agent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(ownedSend).not.toHaveBeenCalled();
      await session.interrupt();
      await session.run("Retry the turn");
      expect(sdk.Agent.cancelRun).toHaveBeenCalledTimes(2);
      expect(attachQuestionHandler).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        expect.any(Function),
      );
      expect(attachQuestionHandler.mock.invocationCallOrder[0]).toBeLessThan(
        prepare.mock.invocationCallOrder[0],
      );
      expect(attachQuestionHandler.mock.invocationCallOrder[0]).toBeLessThan(
        ownedSend.mock.invocationCallOrder[0],
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(ownedSend).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

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
        vi.stubEnv("HOME", cwd);
        vi.stubEnv("USERPROFILE", cwd);
        vi.stubEnv("CODEX_HOME", join(cwd, ".codex"));
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
          commands: [{ name: "compact", kind: "command" }],
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

  it.each(["stop", "rotate", "skill", "lateRotate"] as const)(
    "revalidates a pending %s change during native credential rebinding",
    async (change) => {
      vi.stubEnv("CURSOR_API_KEY", "");
      const { config, load, modelList, sdk, agent, send, storePath } = fixture();
      const enteredResume = Promise.withResolvers<void>();
      const releaseResume = Promise.withResolvers<void>();
      const enteredSkills = Promise.withResolvers<void>();
      const releaseSkills = Promise.withResolvers<void>();
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
        const resolveCursorSkills = vi.fn(async () => {
          if (change === "skill") {
            throw new Error("Cursor skill changed. Select it again from the skill menu.");
          }
          enteredSkills.resolve();
          await releaseSkills.promise;
          return [];
        });
        const hasSkill = change === "skill" || change === "lateRotate";
        const start = hasSkill
          ? session.startTurn(
              [
                { type: "text", text: "blocked dispatch" },
                {
                  type: "cursor_skill",
                  reference: {
                    name: "sample-skill",
                    scope: "workspace",
                    id: "a".repeat(64),
                    revision: "b".repeat(64),
                  },
                },
              ],
              { resolveCursorSkills },
            )
          : session.startTurn("blocked dispatch");
        void start.catch(() => {});
        await Promise.race([enteredResume.promise, start]);
        expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
        const stop = change === "stop" ? session.interrupt() : undefined;
        if (change === "rotate") key = "latest";
        expect(resolveCursorSkills).not.toHaveBeenCalled();
        releaseResume.resolve();
        if (change === "lateRotate") {
          await Promise.race([enteredSkills.promise, start]);
          key = "latest";
          releaseSkills.resolve();
        }
        const errors = {
          stop: "stopped before dispatch",
          rotate: "sign-in changed",
          skill: "Select it again from the skill menu",
          lateRotate: "sign-in changed",
        };
        await expect(start).rejects.toThrow(errors[change]);
        expect(resolveCursorSkills).toHaveBeenCalledTimes(hasSkill ? 1 : 0);
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
        if (change === "rotate" || change === "lateRotate") {
          expect(sdk.Agent.resume).toHaveBeenLastCalledWith(
            agentId,
            expect.objectContaining({ apiKey: "latest" }),
          );
        }
      } finally {
        releaseResume.resolve();
        releaseSkills.resolve();
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
        isDefault: true,
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
      expect.objectContaining({
        model: { id: "model", params: [{ id: "reasoning", value: "high" }] },
      }),
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

  it("shows Cursor questions and searches live and on replay with sparse completions", async () => {
    const { client, config, send } = fixture();
    const ask = {
      name: "mcp",
      call_id: "ask",
      args: { providerIdentifier: "custom-user-tools", toolName: "ask_question", args: {} },
      result: {
        status: "success",
        value: {
          isError: true,
          content: [{ text: { text: "The human dismissed the question." } }],
        },
      },
    };
    const grep = {
      name: "grep",
      call_id: "grep",
      args: { pattern: "setup-ci-tools", path: ".github/workflows" },
      result: { status: "success", value: { workspaceResults: {} } },
    };
    const glob = {
      name: "glob",
      call_id: "glob",
      args: { globPattern: ".github/**/*", targetDirectory: "/repo" },
      result: { status: "success", value: { files: [], totalFiles: 0 } },
    };
    const tools = [ask, grep, glob];
    const events: SDKMessage[] = tools.flatMap(({ name, call_id, args, result }) => {
      const call = { ...eventIds, type: "tool_call" as const, name, call_id };
      return [
        { ...call, status: "running", args },
        { ...call, status: "completed", result, ...(name === "grep" ? {} : { args: {} }) },
      ];
    });
    send.mockResolvedValue(makeRun(events, { id: runId, status: "finished" }));
    const session = await client.createSession(config);
    const live: AgentStreamEvent[] = [];
    session.subscribe((event) => live.push(event));
    await session.run("Inspect the workflow, then ask a question.");
    const calls = (timeline: AgentStreamEvent[]) =>
      timeline.flatMap((event) =>
        event.type === "timeline" && event.item.type === "tool_call" ? [event.item] : [],
      );
    const liveCalls = calls(live);
    expect(liveCalls.map((item) => item.status)).toEqual([
      "running",
      "failed",
      "running",
      "completed",
      "running",
      "completed",
    ]);
    expect(liveCalls.map(buildToolCallDisplayModel)).toEqual([
      { displayName: "Ask question" },
      { displayName: "Ask question", errorText: "The human dismissed the question." },
      { displayName: "Search", summary: grep.args.pattern },
      { displayName: "Search", summary: grep.args.pattern },
      { displayName: "Search", summary: glob.args.globPattern },
      { displayName: "Search", summary: glob.args.globPattern },
    ]);
    expect(liveCalls[1]).toMatchObject({
      name: "custom-user-tools.ask_question",
      detail: { type: "unknown", input: {}, output: "The human dismissed the question." },
      metadata: { cursorSdk: { name: "mcp", input: ask.args, output: ask.result } },
    });
    for (const [index, call] of [grep, glob].entries()) {
      expect(liveCalls[index * 2 + 3].metadata?.cursorSdk).toMatchObject({
        input: call.args,
        output: call.result,
      });
    }
    const replay = calls(await Array.fromAsync(session.streamHistory()));
    expect(replay).toEqual(
      liveCalls.map((item) =>
        AgentTimelineItemPayloadSchema.parse(JSON.parse(JSON.stringify(item))),
      ),
    );
    await session.close();
  });

  it("shows MCP images live without hiding the final answer", async () => {
    const { client, config, send } = fixture();
    const call = { ...eventIds, type: "tool_call" as const, name: "mcp", call_id: "shot" };
    const args = { providerIdentifier: "browser", toolName: "screenshot", args: {} };
    const png = Buffer.from("not really a png").toString("base64");
    const result = {
      status: "success",
      value: { isError: false, content: [{ image: { data: png, mimeType: "image/png" } }] },
    };
    send.mockResolvedValue(
      makeRun(
        [
          { ...call, status: "running", args },
          { ...call, status: "completed", args, result },
        ],
        { id: runId, status: "finished", result: "final answer" },
      ),
    );
    const session = await client.createSession(config);
    const live: AgentStreamEvent[] = [];
    session.subscribe((event) => live.push(event));
    await session.run("Take a screenshot.");
    const items = live.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    expect(items.map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
      "assistant_message",
    ]);
    expect(items[2]).toMatchObject({ detail: { type: "unknown", input: {}, output: "[image]" } });
    expect(items[3]).toMatchObject({
      text: expect.stringMatching(/^\n\n!\[Image\]\(file:\/\/.*paseo-attachments.*\.png\)\n\n$/),
    });
    expect(items[4]).toEqual({ type: "assistant_message", text: "final answer" });
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
      detail: { type: "read", filePath: "test.txt" },
      metadata: { cursorSdk: { projection: 3, input: tool.args, output: null } },
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

it("keeps the canonical model and parameters when a new account changes its aliases", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  const { config, load, sdk, agent, send, storePath } = fixture();
  const fast = "cursor_model_fast";
  const accountModel = (values: string[], aliases?: string[]): SDKModel => ({
    id: "default",
    displayName: "Auto",
    aliases,
    parameters: [{ id: "fast", values: values.map((value) => ({ value })) }],
    variants: [{ isDefault: true, displayName: "Fast", params: [{ id: "fast", value: "true" }] }],
  });
  const catalogs = {
    original: [
      { id: "auto-smart", displayName: "Auto", aliases: ["default"] },
      accountModel(["true", "false"], ["auto"]),
    ],
    replacement: [
      { id: "auto-smart", displayName: "Auto", aliases: ["auto"] },
      accountModel(["true"]),
    ],
    unavailable: [{ id: "auto-smart", displayName: "Auto", aliases: ["auto"] }],
  };
  let key: keyof typeof catalogs = "original";
  const catalog = vi.fn(async (apiKey: string) => catalogs[apiKey as keyof typeof catalogs]);
  const client = new CursorSdkAgentClient(undefined, load, catalog, async () => key, storePath);
  const session = await client.createSession({ ...config, model: "default" });
  try {
    const result = makeRun([], { id: runId, status: "finished" });
    const replacementSend = vi.fn().mockResolvedValue(result);
    send.mockResolvedValue(result);
    sdk.Agent.resume.mockResolvedValue({ ...agent, send: replacementSend });
    await session.run("original account");
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: { id: "auto", params: [{ id: "fast", value: "true" }] },
      }),
    );

    await session.applyOptions?.({ [fast]: false });
    key = "replacement";
    await expect(session.startTurn("unsupported selected Fast")).rejects.toThrow(
      "Unsupported Cursor SDK model option",
    );
    await session.interrupt();
    expect(sdk.Agent.resume).not.toHaveBeenCalled();
    expect(agent[Symbol.asyncDispose]).not.toHaveBeenCalled();
    await expect(session.applyOptions?.({ [fast]: false })).rejects.toThrow(
      "Unsupported Cursor SDK model option",
    );
    await session.applyOptions?.({ [fast]: true });
    await session.run("rotated account");
    await session.run("same rotated account again");
    const selection = { id: "default", params: [{ id: "fast", value: "true" }] };
    expect(sdk.Agent.resume).toHaveBeenCalledExactlyOnceWith(
      agentId,
      expect.objectContaining({ apiKey: "replacement", model: selection }),
    );
    expect(replacementSend.mock.calls.map((call) => call[1].model)).toEqual([selection, selection]);
    expect(catalog.mock.calls.map(([apiKey]) => apiKey)).toEqual(["original", "replacement"]);
    expect((await session.getRuntimeInfo()).model).toBe("default");
    expect(session.controls?.[0]).toMatchObject({ choices: [{ value: "true" }] });

    key = "unavailable";
    await expect(session.startTurn("unavailable account")).rejects.toThrow("unavailable");
    await session.interrupt();
    expect(sdk.Agent.resume).toHaveBeenCalledOnce();
    expect(replacementSend).toHaveBeenCalledTimes(2);
  } finally {
    await session.close();
    vi.unstubAllEnvs();
  }
});

it("coalesces SDK question callback replay and fences a stopped turn", async () => {
  const emit = vi.fn();
  const questions = new CursorQuestions(emit);
  const controller = new AbortController();
  const tool = questions.tool(controller.signal);
  const input = {
    questions: [{ question: "Pick one", options: ["Yes", "Maybe"], is_multi_select: true }],
  };
  const context = { sessionId: "task-session", toolCallId: "same-call" };

  const malformed = { questions: [{ question: "Pick one", options: [true, false] }] };
  const invalid = await tool.execute(malformed, context);
  expect(invalid).toMatchObject({ isError: true });
  expect(JSON.stringify(invalid)).toContain("questions[0].options[0]");
  const answer = tool.execute(input, context);
  const changed = { questions: [{ ...input.questions[0], question: "A different question" }] };
  expect(tool.execute(input, context)).toBe(answer);
  expect(await tool.execute(changed, context)).toMatchObject({ isError: true });
  const [request] = questions.requests();
  expect(request.input?.questions).toEqual([
    {
      header: "Question 1",
      question: "Pick one",
      options: [{ label: "Yes" }, { label: "Maybe" }],
      multiSelect: true,
      allowOther: true,
    },
  ]);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(() =>
    questions.respond(request.id, {
      behavior: "allow",
      updatedInput: { answers: { Wrong: "No" } },
    }),
  ).toThrow("valid answer");
  expect(questions.requests()).toEqual([request]);
  questions.respond(request.id, {
    behavior: "allow",
    updatedInput: { answers: { "Question 1": "Yes, My write-in" } },
  });
  expect(await answer).toEqual({ answers: { "Question 1": "Yes, My write-in" } });
  expect(tool.execute(input, context)).toBe(answer);
  expect(await tool.execute(changed, context)).toMatchObject({ isError: true });

  const other = tool.execute(input, { ...context, sessionId: "another-task" });
  const [pending] = questions.requests();
  controller.abort();
  expect(await other).toMatchObject({ isError: true });
  expect(questions.requests()).toEqual([]);
  expect(() => questions.respond(pending.id, { behavior: "allow" })).toThrow("no longer pending");
  expect(await tool.execute(input, context)).toMatchObject({ isError: true });
});

test("rewind moves the session to a fork and sends the next prompt there", async () => {
  const storePath = await mkdtemp(join(tmpdir(), "paseo-cursor-rewind-"));
  stores.push(storePath);
  const cwd = await realpath(process.cwd());
  const realSdk = await import("@cursor/sdk");
  const store = new realSdk.JsonlLocalAgentStore(storePath);
  const time = Date.UTC(2026, 10, 21);
  const ref = (rootBlobId: string) => ({ schemaVersion: 1 as const, rootBlobId });
  await store.agents.create({
    agent: {
      agentId,
      cwd,
      status: "idle",
      createdAt: time,
      updatedAt: time,
      latestCheckpoint: ref("b2"),
    },
  });
  const journal = new CursorTurnJournal(storePath, agentId);
  for (const [turn, start, latest] of [
    [1, null, "b1"],
    [2, "b1", "b2"],
  ] as const) {
    await store.checkpoints.create({ agentId, blobId: latest, data: new Uint8Array([turn]) });
    await store.runs.create({
      run: {
        agentId,
        runId: `run-${turn}`,
        turnNumber: turn,
        status: "finished",
        createdAt: time + turn,
        updatedAt: time + turn,
        startedAt: time + turn,
        endedAt: time + turn,
        startCheckpointRef: start && ref(start),
        latestCheckpointRef: ref(latest),
      },
    });
    const record: CursorHistoryTurn = {
      id: `turn-${turn}`,
      nativeRunId: `run-${turn}`,
      createdAt: new Date(time + turn).toISOString(),
      user: { type: "user_message", text: `prompt ${turn}`, messageId: `message-${turn}` },
      steers: [],
      joined: true,
      terminal: { status: "finished" },
    };
    await journal.admit(record, record.user.text);
  }
  const agents = new Map<string, { agentId: string; send: ReturnType<typeof vi.fn> }>();
  const open = (id: string) => {
    const agent = {
      agentId: id,
      send: vi.fn(async () => makeRun([], { id: `run-next-${id}`, status: "finished" })),
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
    agents.set(id, agent);
    return agent;
  };
  const sdk = {
    ...realSdk,
    JsonlLocalAgentStore: function JsonlLocalAgentStore() {
      return store;
    },
    Agent: {
      create: vi.fn(),
      resume: vi.fn(async (id: string) => open(id)),
      cancelRun: vi.fn(),
      messages: { list: vi.fn(async () => []) },
    },
  };
  const client = new CursorSdkAgentClient(
    { env: { CURSOR_API_KEY: "test-key" } },
    vi.fn(async () => sdk) as unknown as NonNullable<
      ConstructorParameters<typeof CursorSdkAgentClient>[1]
    >,
    vi.fn(async () => [model]),
    undefined,
    storePath,
  );
  const session = await client.resumeSession(
    { provider, sessionId: agentId, nativeHandle: agentId, metadata: { cwd } },
    { model: "model" },
  );
  try {
    await session.revertConversation!({ messageId: "message-2" });
    const forkId = session.id!;
    expect(forkId).not.toBe(agentId);
    expect(session.describePersistence()).toMatchObject({
      sessionId: forkId,
      nativeHandle: forkId,
    });
    expect((await store.agents.get({ agentId: forkId }))?.latestCheckpoint).toEqual(ref("b1"));
    expect(agents.get(agentId)?.[Symbol.asyncDispose]).toHaveBeenCalled();
    const history = (await Array.fromAsync(session.streamHistory())).flatMap((event) =>
      event.type === "timeline" && event.item.type === "user_message" ? [event.item.text] : [],
    );
    expect(history).toEqual(["prompt 1"]);

    await session.run("next");
    expect(agents.get(forkId)?.send).toHaveBeenCalledOnce();
    expect(agents.get(agentId)?.send).not.toHaveBeenCalled();
    expect((await store.agents.get({ agentId }))?.latestCheckpoint).toEqual(ref("b2"));
  } finally {
    await session.close();
  }
});

test("reports model context limits in catalog, forwards model-call-completed deltas, and emits max updates on model/option changes", async () => {
  const realSdk = await import("@cursor/sdk");
  const storePath = await mkdtemp(join(tmpdir(), "paseo-cursor-context-"));
  stores.push(storePath);
  const cwd = await mkdtemp(join(tmpdir(), "paseo-cursor-context-cwd-"));
  stores.push(cwd);

  const neonModel: SDKModel = {
    id: "gemini-4-neon",
    displayName: "Gemini 4 Neon",
    parameters: [{ id: "context", values: [{ value: "300k" }, { value: "1m" }] }],
    variants: [
      { displayName: "300K", isDefault: true, params: [{ id: "context", value: "300k" }] },
      { displayName: "1M", params: [{ id: "context", value: "1m" }] },
    ],
  };
  const autoModel: SDKModel = { id: "default", displayName: "Auto", aliases: ["auto"] };

  const store = new realSdk.JsonlLocalAgentStore(storePath);
  const contextAgentId = "agent-context-test";
  await store.agents.create({
    agent: {
      agentId: contextAgentId,
      cwd,
      status: "idle",
      activeRunId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  });

  const nativeSend = vi.fn(
    async (_input: unknown, options?: { onDelta?: (arg: { update: unknown }) => void }) => {
      options?.onDelta?.({
        update: {
          type: "model-call-completed",
          modelCallId: "mc-1",
          usage: {
            inputTokens: 8_000,
            outputTokens: 500,
            cacheReadTokens: 4_000,
            cacheWriteTokens: 0,
          },
        },
      });
      options?.onDelta?.({
        update: {
          type: "model-call-completed",
          modelCallId: "mc-2",
          usage: {
            inputTokens: 11_000,
            outputTokens: 600,
            cacheReadTokens: 8_000,
            cacheWriteTokens: 0,
          },
        },
      });
      return makeRun([], {
        id: "run-ctx-1",
        status: "finished",
        usage: {
          inputTokens: 19_000,
          cacheReadTokens: 12_000,
          cacheWriteTokens: 0,
          outputTokens: 1_100,
          totalTokens: 20_100,
        },
      });
    },
  );

  const sdk = {
    ...realSdk,
    JsonlLocalAgentStore: function JsonlLocalAgentStore() {
      return store;
    },
    Agent: {
      create: vi.fn(async () => ({
        agentId: contextAgentId,
        send: nativeSend,
        [Symbol.asyncDispose]: vi.fn(async () => {}),
      })),
      resume: vi.fn(),
      cancelRun: vi.fn(),
      messages: { list: vi.fn(async () => []) },
    },
  };
  const client = new CursorSdkAgentClient(
    { env: { CURSOR_API_KEY: "test-key" } },
    vi.fn(async () => sdk) as unknown as NonNullable<
      ConstructorParameters<typeof CursorSdkAgentClient>[1]
    >,
    vi.fn(async () => [neonModel, autoModel]),
    undefined,
    storePath,
  );

  const catalog = await client.fetchCatalog({});
  expect(catalog.models.find((m) => m.id === "gemini-4-neon")?.contextWindowMaxTokens).toBe(
    300_000,
  );
  expect(catalog.models.find((m) => m.id === "default")?.contextWindowMaxTokens).toBeUndefined();

  const session = await client.createSession({ provider, cwd, model: "gemini-4-neon" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const result = await session.run("inspect context");
    expect(result.usage).toMatchObject({
      contextWindowUsedTokens: 11_600,
      contextWindowMaxTokens: 300_000,
    });

    events.length = 0;
    await session.applyOptions!({ cursor_model_context: "1m" });
    expect(events).toContainEqual({
      type: "usage_updated",
      provider,
      sessionOnly: true,
      usage: { contextWindowMaxTokens: 1_000_000 },
    });
    expect(await session.readLastUsage!()).toMatchObject({
      contextWindowUsedTokens: 11_600,
      contextWindowMaxTokens: 1_000_000,
    });

    events.length = 0;
    await session.setModel("auto");
    expect(events).toContainEqual({
      type: "usage_updated",
      provider,
      sessionOnly: true,
      usage: {},
      clearContextWindowMax: true,
    });
    expect((await session.readLastUsage!())?.contextWindowMaxTokens).toBeUndefined();
  } finally {
    await session.close();
  }
});
