import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  waitForNextEvent,
  waitForTimelineToolCall,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { startAgentRun } from "../agent-prompt.js";
import { respondToAgentPermission } from "../permission-response.js";
import { waitForHeldMessage } from "../held-messages.js";
import { buildStoredAgentPayload, toAgentPayload } from "../agent-projections.js";

const questionItem = {
  type: "agentMessage",
  id: "async-question-1",
  text: "Which color?\n- Blue\n- Green",
  phase: "final_answer",
  delivery: "async",
  questions: [{ title: "Which color?", options: ["Blue", "Green"] }],
};

async function setup(metadata?: Record<string, unknown>, rejectSteer = false) {
  const appServer = createFakeCodexAppServer({
    "turn/interrupt": () => ({}),
    "turn/steer": () => {
      if (rejectSteer) return { __jsonRpcError: { code: -32000, message: "Delivery failed" } };
      return { turnId: "native-turn" };
    },
    "thread/read": () => ({ thread: { id: "thread-1", turns: [] } }),
    "thread/backgroundTerminals/list": () => ({ data: [], nextCursor: null }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4", modeId: "full-access" },
    metadata ? { sessionId: "thread-1", metadata } : null,
    createTestLogger(),
    async () => appServer.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.startTurn("Help me choose a color while you inspect the project.");
  const started = waitForNextEvent(session, "turn_started");
  appServer.startsTurn({ threadId: "thread-1", turnId: "native-turn" });
  await started;
  async function ask() {
    const shown = waitForTimelineToolCall(session, questionItem.id);
    appServer.child.stdout.write(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "native-turn", item: questionItem },
      }) + "\n",
    );
    await shown;
  }
  async function say(text: string) {
    const shown = waitForNextEvent(
      session,
      "timeline",
      (event) => event.item.type === "assistant_message" && event.item.text.includes(text),
    );
    appServer.says({ threadId: "thread-1", text });
    await shown;
  }
  async function finish(status: "completed" | "interrupted" = "completed") {
    const finished = waitForNextEvent(
      session,
      status === "completed" ? "turn_completed" : "turn_canceled",
    );
    appServer.completeTurn({ status });
    await finished;
  }
  function allowAnswers() {
    rejectSteer = false;
  }
  return { session, appServer, events, ask, say, finish, allowAnswers };
}

const answer = { behavior: "allow" as const, updatedInput: { answers: { "Question 1": "Green" } } };

async function setupRewind(fail = false) {
  const records = [
    { item: { ...questionItem, id: "earlier-pending" } },
    { item: { ...questionItem, id: "earlier-answered" }, resolution: ["Blue"] },
    { item: { ...questionItem, id: "removed-pending" } },
    { item: { ...questionItem, id: "removed-answered" }, resolution: ["Green"] },
  ];
  function userMessage(id: string) {
    return { type: "userMessage", id, content: [{ type: "text", text: id }] };
  }
  const turns = [
    {
      id: "earlier-turn",
      items: [userMessage("earlier"), ...records.slice(0, 2).map((r) => r.item)],
    },
    {
      id: "removed-turn",
      items: [userMessage("rewind-here"), ...records.slice(2).map((r) => r.item)],
    },
  ];
  const appServer = createFakeCodexAppServer({
    "thread/read": (params) => {
      const { threadId } = params as { threadId: string };
      return {
        thread: { id: threadId, turns: threadId === "thread-1" ? turns : turns.slice(0, 1) },
      };
    },
    ...(fail
      ? {
          "thread/rollback": () => ({ __jsonRpcError: { code: -32000, message: "Rewind failed" } }),
        }
      : {}),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4", modeId: "full-access" },
    { sessionId: "thread-1", metadata: { asyncQuestions: records } },
    createTestLogger(),
    async () => appServer.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  return { session, events, records };
}

test("rewind removes only questions outside the remaining history, including after resume", async () => {
  const { session, events, records } = await setupRewind();
  let metadata: Record<string, unknown> | undefined;
  try {
    await session.revertConversation({ messageId: "rewind-here" });
    expect(session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
    ]);
    metadata = session.describePersistence()!.metadata;
    expect(metadata.asyncQuestions).toEqual(
      records.slice(0, 2).map((record) => ({
        resolution: record.resolution,
        item: {
          type: "agentMessage",
          id: record.item.id,
          delivery: "async",
          questions: questionItem.questions,
        },
      })),
    );
    expect(events.filter((e) => e.type === "permission_resolved")).toEqual([
      expect.objectContaining({ requestId: "permission-removed-pending" }),
    ]);
    const history = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(
      history.some(
        (e) =>
          e.type === "timeline" &&
          e.item.type === "tool_call" &&
          e.item.callId === "removed-pending",
      ),
    ).toBe(false);
  } finally {
    await session.close();
  }
  const resumed = await setup(metadata);
  try {
    expect(resumed.session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
    ]);
  } finally {
    await resumed.session.close();
  }
});

test("failed rewind preserves question state", async () => {
  const { session, events } = await setupRewind(true);
  try {
    const before = session.describePersistence();
    await expect(session.revertConversation({ messageId: "rewind-here" })).rejects.toThrow(
      "Rewind failed",
    );
    expect(session.describePersistence()).toEqual(before);
    expect(session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
      "permission-removed-pending",
    ]);
    expect(events.some((e) => e.type === "permission_resolved")).toBe(false);
  } finally {
    await session.close();
  }
});

async function manage(session: CodexAppServerAgentSession, registry?: AgentStorage) {
  const manager = new AgentManager({
    registry,
    clients: {
      codex: {
        provider: "codex",
        capabilities: session.capabilities,
        createSession: async () => session,
        resumeSession: async () => session,
        isAvailable: async () => true,
        fetchCatalog: async () => ({ models: [], modes: [] }),
      },
    },
    logger: createTestLogger(),
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4" },
    undefined,
    { workspaceId: undefined },
  );
  return { manager, agent };
}

test("manager publishes and saves the provider state after rewind", async () => {
  const { session } = await setupRewind();
  const { manager, agent } = await manage(session);
  try {
    await manager.rewind(agent.id, "rewind-here", "conversation");
    const snapshot = manager.getAgent(agent.id)!;
    expect(Array.from(snapshot.pendingPermissions.keys())).toEqual(["permission-earlier-pending"]);
    expect(snapshot.persistence).toEqual(session.describePersistence());
    expect(snapshot.persistence?.sessionId).toBe("forked-thread");
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("cold startup exposes saved questions without a runtime; failed and concurrent answers remain safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-saved-question-"));
  const storage = new AgentStorage(join(root, "agents"), createTestLogger());
  const first = await setup();
  await first.ask();
  await first.finish();
  const { manager, agent } = await manage(first.session, storage);
  let replacement: AgentManager | undefined;
  let resumed: CodexAppServerAgentSession | undefined;
  let rejectStart = true;
  const server = createFakeCodexAppServer({
    "thread/read": () => ({ thread: { id: "thread-1", turns: [] } }),
    "turn/start": () =>
      rejectStart ? { __jsonRpcError: { code: -32000, message: "Follow-up rejected" } } : {},
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await expect(manager.stopAdmittingIfIdle()).resolves.toBe(true);
    await manager.closeAgent(agent.id);
    await storage.flush();
    // No startup-resume intent: this idle agent must not receive "Resume working".
    const record = (await storage.get(agent.id))!;
    expect(record.resumeOnStartup).not.toBe(true);
    expect(buildStoredAgentPayload(record, ["codex"]).pendingPermissions).toMatchObject([
      { id: "permission-async-question-1", kind: "question" },
    ]);
    replacement = new AgentManager({
      registry: storage,
      logger: createTestLogger(),
      clients: {
        codex: {
          provider: "codex",
          capabilities: first.session.capabilities,
          createSession: async () => {
            throw new Error("Must resume the original thread");
          },
          resumeSession: async (handle, config) => {
            resumed = new CodexAppServerAgentSession(
              config,
              handle,
              createTestLogger(),
              async () => server.child,
            );
            return resumed;
          },
          isAvailable: async () => true,
          fetchCatalog: async () => ({ models: [], modes: [] }),
        },
      },
    });
    expect(replacement.listAgents()).toEqual([]);
    const resolutions: unknown[] = [];
    replacement.subscribe((event) => {
      if (event.type === "agent_stream" && event.event.type === "permission_resolved")
        resolutions.push(event.event);
    });
    const respond = () =>
      replacement!.respondToPermission(agent.id, "permission-async-question-1", answer);
    await expect(respond()).rejects.toThrow("Follow-up rejected");
    expect(replacement.getPendingPermissions(agent.id)).toHaveLength(1);
    expect(toAgentPayload(replacement.getAgent(agent.id)!).pendingPermissions).toHaveLength(1);
    expect(resolutions).toEqual([]);
    expect(resumed!.getPendingPermissions()).toHaveLength(1);
    expect(
      buildStoredAgentPayload((await storage.get(agent.id))!, ["codex"]).pendingPermissions,
    ).toHaveLength(1);
    rejectStart = false;
    const results = await Promise.allSettled([respond(), respond()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(resumed!.getPendingPermissions()).toEqual([]);
    const starts = server.requests().filter((r) => r.method === "turn/start");
    expect(starts).toHaveLength(2); // One rejected attempt, one accepted answer.
    expect(starts[1]).toMatchObject({
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: expect.stringContaining("Which color?\nGreen") }],
      },
    });
    await replacement.closeAgent(agent.id);
    await storage.flush();
    expect(
      buildStoredAgentPayload((await storage.get(agent.id))!, ["codex"]).pendingPermissions,
    ).toEqual([]);
  } finally {
    if (replacement?.getAgent(agent.id)) await replacement.closeAgent(agent.id);
    if (manager.getAgent(agent.id)) await manager.closeAgent(agent.id);
    await first.session.close();
    await storage.flush();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a saved question never bypasses or dismisses a live input approval", async () => {
  const { session, appServer, ask, finish } = await setup();
  await ask();
  await finish();
  const { manager, agent } = await manage(session);
  try {
    const requested = waitForNextEvent(session, "permission_requested");
    appServer.requestUserInput({
      itemId: "live-question",
      threadId: "thread-1",
      turnId: "native-turn",
      questions: [
        {
          id: "live",
          header: "Live",
          question: "Approve?",
          options: [{ label: "Yes", description: "Yes" }],
        },
      ],
    });
    await requested;
    await expect(manager.stopAdmittingIfIdle()).resolves.toBe(false);
    await expect(
      manager.respondToPermission(agent.id, "permission-async-question-1", answer),
    ).rejects.toThrow("Resolve the live permission request");
    expect(session.getPendingPermissions()).toHaveLength(2);
    expect(appServer.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("an idle question answer starts before queued messages without canceling either turn", async () => {
  const { session, appServer, ask, finish } = await setup();
  await ask();
  await finish();
  const { manager, agent } = await manage(session);
  const events: AgentStreamEvent[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") events.push(event.event);
    },
    { agentId: agent.id, replayState: false },
  );
  const logger = createTestLogger();
  const starts = () => appServer.requests().filter((r) => r.method === "turn/start");
  try {
    await expect(
      startAgentRun(manager, agent.id, "Queued work", logger, {
        activeTurnBehavior: "queue",
        runOptions: { clientMessageId: "queued-work" },
      }),
    ).resolves.toEqual({ disposition: "queued" });
    const queued = waitForHeldMessage(manager, agent.id, "queued-work");
    expect(queued).not.toBeNull();

    await respondToAgentPermission({
      agentManager: manager,
      agentId: agent.id,
      requestId: "permission-async-question-1",
      response: answer,
      logger,
    });
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toMatchObject({
      params: {
        input: [{ type: "text", text: "Answers to your questions:\n\nWhich color?\nGreen" }],
      },
    });
    expect(manager.getPendingPermissions(agent.id)).toEqual([]);
    expect(waitForHeldMessage(manager, agent.id, "queued-work")).toBe(queued);

    appServer.startsTurn({ threadId: "thread-1", turnId: "answer-turn" });
    appServer.completeTurn();
    await expect(queued).resolves.toBe("dispatched");
    await expect.poll(() => starts().length).toBe(3);
    expect(starts()[2]).toMatchObject({
      params: {
        input: [{ type: "text", text: "Queued work" }],
      },
    });
    appServer.startsTurn({ threadId: "thread-1", turnId: "queued-turn" });
    appServer.completeTurn();
    await expect.poll(() => manager.hasInFlightRun(agent.id)).toBe(false);
    expect(
      events.filter((event) => event.type === "turn_failed" || event.type === "turn_canceled"),
    ).toEqual([]);
    expect(appServer.requests().filter((r) => r.method === "turn/interrupt")).toEqual([]);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});

test("manager snapshots capture pending and answered question state before the turn ends", async () => {
  const { session, ask } = await setup();
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(manager.getAgent(agent.id)?.persistence?.metadata?.asyncQuestions).toEqual([
      {
        item: {
          type: "agentMessage",
          id: questionItem.id,
          delivery: "async",
          questions: questionItem.questions,
        },
      },
    ]);
    await manager.respondToPermission(agent.id, permission.id, answer);
    expect(manager.getAgent(agent.id)?.persistence?.metadata?.asyncQuestions).toEqual([
      {
        item: {
          type: "agentMessage",
          id: questionItem.id,
          delivery: "async",
          questions: questionItem.questions,
        },
        resolution: ["Green"],
      },
    ]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("concurrent answers deliver only one response to the active Codex turn", async () => {
  const { session, appServer, ask } = await setup();
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    const results = await Promise.allSettled([
      manager.respondToPermission(agent.id, permission.id, answer),
      manager.respondToPermission(agent.id, permission.id, answer),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(appServer.requests().filter((request) => request.method === "turn/steer")).toHaveLength(
      1,
    );
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a failed submission releases the request so the user can retry", async () => {
  const { session, ask, allowAnswers } = await setup(undefined, true);
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    await expect(manager.respondToPermission(agent.id, permission.id, answer)).rejects.toThrow(
      "Delivery failed",
    );
    expect(session.getPendingPermissions().map((request) => request.id)).toEqual([permission.id]);
    allowAnswers();
    await manager.respondToPermission(agent.id, permission.id, answer);
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("malformed answers leave the async question pending until a corrected retry", async () => {
  const { session, appServer, events, ask } = await setup();
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    for (const updatedInput of [
      { answers: { "0": { answers: ["Green"] } } },
      { "0": "Green" },
      { answers: { "0": "Green" } },
      { answers: { "Question 1": " " } },
    ]) {
      await expect(
        manager.respondToPermission(agent.id, permission.id, { behavior: "allow", updatedInput }),
      ).rejects.toThrow();
      expect(session.getPendingPermissions()).toEqual([permission]);
      expect(toAgentPayload(manager.getAgent(agent.id)!).pendingPermissions).toEqual([permission]);
      expect(appServer.requests().filter((request) => request.method === "turn/steer")).toEqual([]);
      expect(events.filter((event) => event.type === "permission_resolved")).toEqual([]);
    }
    await manager.respondToPermission(agent.id, permission.id, answer);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(appServer.requests().filter((request) => request.method === "turn/steer")).toHaveLength(
      1,
    );
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("shows an async question, keeps streaming, and delivers its answer without interrupting", async () => {
  const { session, appServer, events, ask, say } = await setup();
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toMatchObject({
      kind: "question",
      input: {
        questions: [
          {
            header: "Question 1",
            question: "Which color?",
            isOther: true,
            options: [{ label: "Blue" }, { label: "Green" }],
          },
        ],
      },
    });
    await say("I am still inspecting the project.");
    expect(
      events.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("still inspecting"),
      ),
    ).toBe(true);
    await session.respondToPermission(permission.id, answer);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(appServer.requests().filter((request) => request.method === "turn/steer")).toMatchObject(
      [
        {
          params: {
            expectedTurnId: "native-turn",
            clientUserMessageId: expect.any(String),
            input: [{ type: "text", text: expect.stringContaining("Which color?\nGreen") }],
          },
        },
      ],
    );
    expect(appServer.requests().filter((request) => request.method === "turn/interrupt")).toEqual(
      [],
    );
    expect(
      events.some(
        (event) => event.type === "permission_resolved" && event.requestId === permission.id,
      ),
    ).toBe(true);
  } finally {
    await session.close();
  }
});

test("keeps a failed answer pending for retry", async () => {
  const { session, ask } = await setup(undefined, true);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toBeDefined();
    await expect(session.respondToPermission(permission.id, answer)).rejects.toThrow();
    expect(session.getPendingPermissions()).toHaveLength(1);
  } finally {
    await session.close();
  }
});

test("Stop dismisses async questions before cancellation and keeps them dismissed after resume", async () => {
  const first = await setup();
  let metadata: Record<string, unknown> | undefined;
  try {
    await first.ask();
    expect(first.session.getPendingPermissions()).toHaveLength(1);
    first.session.subscribe((event) => {
      if (event.type === "turn_canceled") {
        metadata = first.session.describePersistence()!.metadata;
      }
    });
    await first.session.interrupt();
    await first.finish("interrupted");
    expect(first.session.getPendingPermissions()).toEqual([]);
    expect(metadata?.asyncQuestions).toEqual([
      expect.objectContaining({ resolution: "dismissed" }),
    ]);
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "permission-async-question-1",
        resolution: { behavior: "deny", message: "Interrupted" },
      }),
    );
  } finally {
    await first.session.close();
  }
  const resumed = await setup(metadata);
  try {
    await resumed.ask();
    expect(resumed.session.getPendingPermissions()).toEqual([]);
  } finally {
    await resumed.session.close();
  }
});

test("late answers use the existing follow-up prompt and dismissal does not interrupt", async () => {
  const { session, appServer, ask, finish } = await setup();
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toBeDefined();
    await finish();
    expect(session.getPendingPermissions()).toHaveLength(1);
    const result = await session.respondToPermission(permission.id, answer);
    expect(result).toEqual({
      followUpPrompt: "Answers to your questions:\n\nWhich color?\nGreen",
      complete: expect.any(Function),
    });
    expect(session.getPendingPermissions()).toHaveLength(1);
    result?.complete?.();
    expect(appServer.requests().some((request) => request.method === "turn/interrupt")).toBe(false);
  } finally {
    await session.close();
  }
});

test("restores unanswered questions and does not reopen answered questions on duplicate events", async () => {
  const first = await setup();
  let metadata: Record<string, unknown> | undefined;
  try {
    await first.ask();
    expect(first.session.getPendingPermissions()).toHaveLength(1);
    metadata = first.session.describePersistence()!.metadata;
  } finally {
    await first.session.close();
  }
  const resumed = await setup(metadata);
  try {
    const [permission] = resumed.session.getPendingPermissions();
    expect(permission).toBeDefined();
    await resumed.session.respondToPermission(permission.id, { behavior: "deny" });
    await resumed.ask();
    expect(resumed.session.getPendingPermissions()).toEqual([]);
    expect(
      resumed.appServer.requests().some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
  } finally {
    await resumed.session.close();
  }
});
