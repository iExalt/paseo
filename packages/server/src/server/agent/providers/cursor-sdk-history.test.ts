import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { expect, test } from "vitest";
import type { AgentStreamEvent, ToolCallTimelineItem } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import { cursorTimelineItems, mapCursorTool, replayCursorTool } from "./cursor-sdk-telemetry.js";
import { readCursorHistory, readCursorLastUsage } from "./cursor-sdk-history.js";
import { CursorTurnJournal, type CursorHistoryTurn } from "./cursor-sdk-turn-journal.js";

const agentId = "agent-offline";
const cwd = "/worktree-no-longer-exists";
const time = Date.parse("2026-11-20T10:00:00Z");

async function withStore(
  callback: (root: string, store: sdk.LocalAgentStore, journal: CursorTurnJournal) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-history-"));
  const store = new sdk.JsonlLocalAgentStore(root);
  try {
    await store.agents.create({
      agent: { agentId, cwd, status: "idle", createdAt: time, updatedAt: time },
    });
    await callback(root, store, new CursorTurnJournal(root, agentId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function localRun(runId: string, status: sdk.LocalAgentRunStatus): sdk.LocalAgentRunDocument {
  return {
    agentId,
    runId,
    status,
    turnNumber: 1,
    createdAt: time,
    startedAt: time,
    updatedAt: time,
    ...(status === "running" ? {} : { endedAt: time + 500 }),
  };
}

const messages = (events: AgentStreamEvent[]) =>
  events.flatMap((event) =>
    event.type === "timeline" ? [{ turnId: event.turnId, item: event.item }] : [],
  );

test("replays cancelled image-only input and omitted stream events from a fresh local reader", async () => {
  await withStore(async (root, store, journal) => {
    const turn: CursorHistoryTurn = {
      id: "paseo-id",
      createdAt: new Date(time).toISOString(),
      user: {
        type: "user_message",
        text: "",
        messageId: "image-message",
        clientMessageId: "image-message",
      },
      steers: [],
    };
    const input = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] as const;
    await journal.admit(turn, [...input]);
    await store.runs.create({ run: localRun("native-cancelled", "cancelled") });
    turn.nativeRunId = "native-cancelled";
    await journal.save(turn);

    const assistant = { type: "assistant_message", text: "ha" } as const;
    await journal.append(turn.id, assistant);
    await journal.append(turn.id, assistant);
    turn.terminal = { status: "cancelled" };
    turn.joined = true;
    await journal.save(turn);

    const journalRoot = join(root, "paseo-turns");
    const [agentDir] = await readdir(journalRoot);
    const directory = join(journalRoot, agentDir);
    const inputFile = (await readdir(directory)).find((name) => name.endsWith(".input.json"));
    if (!inputFile) throw new Error("missing durable image input");
    expect(JSON.parse(await readFile(join(directory, inputFile), "utf8"))).toEqual(input);
    const cold = await Array.fromAsync(
      readCursorHistory(
        sdk,
        new sdk.JsonlLocalAgentStore(root),
        new CursorTurnJournal(root, agentId),
        agentId,
      ),
    );
    expect(messages(cold)).toEqual([
      { turnId: turn.id, item: turn.user },
      { turnId: turn.id, item: assistant },
      { turnId: turn.id, item: assistant },
    ]);
  });
});

test("reads legacy literal instruction text and a detached active run without waiting", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "legacy-running";
    const prompt = "<paseo_instructions>\nkeep this literal\n</paseo_instructions>\n\nhello";
    await store.runs.create({ run: localRun(runId, "running") });
    const events: sdk.SDKMessage[] = [
      {
        type: "user",
        run_id: runId,
        agent_id: agentId,
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      },
      {
        type: "tool_call",
        run_id: runId,
        agent_id: agentId,
        call_id: "shell",
        name: "shell",
        status: "running",
      },
    ];
    for (const event of events) {
      await store.runEvents.append({
        runId,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent(event),
      });
    }
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows).toMatchObject([
      { turnId: runId, item: { type: "user_message", text: prompt, messageId: runId + ":user" } },
      { turnId: runId, item: { type: "tool_call", status: "running" } },
      {
        turnId: runId,
        item: { type: "error", message: expect.stringContaining("no confirmed shutdown") },
      },
    ]);
    expect((await store.runs.get({ agentId, runId }))?.status).toBe("running");
  });
});

test("an interrupted prefix is kept without inventing tool completion from native metadata", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "native-finished-before-journal";
    const turn: CursorHistoryTurn = {
      id: "paseo-interrupted",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "work", messageId: "original" },
      steers: [],
    };
    await journal.admit(turn, "work");
    await journal.append(turn.id, {
      type: "tool_call",
      callId: runId + ":shell",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    await journal.append(turn.id, { type: "assistant_message", text: "same" });
    await journal.append(turn.id, { type: "assistant_message", text: "same" });
    await store.runs.create({ run: localRun(runId, "finished") });

    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows).toMatchObject([
      { turnId: turn.id, item: turn.user },
      { turnId: turn.id, item: { type: "tool_call", status: "running" } },
      { turnId: turn.id, item: { type: "assistant_message", text: "same" } },
      { turnId: turn.id, item: { type: "assistant_message", text: "same" } },
      {
        turnId: turn.id,
        item: { type: "error", message: expect.stringContaining("no confirmed shutdown") },
      },
    ]);
  });
});

test("a named SDK-owned follow-up is replayed once within its admitted Paseo turn", async () => {
  await withStore(async (_root, store, journal) => {
    const firstId = "native-first";
    const nextId = "native-sdk-follow-up";
    const turn: CursorHistoryTurn = {
      id: "paseo-first",
      nativeRunId: firstId,
      followUpIds: [nextId],
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "first", messageId: "original" },
      steers: [{ user: { type: "user_message", text: "steer", messageId: "steered" }, after: 1 }],
    };
    await journal.admit(turn, "first");
    await store.runs.create({ run: localRun(firstId, "finished") });
    await store.runs.create({ run: { ...localRun(nextId, "finished"), turnNumber: 2 } });
    await journal.append(turn.id, { type: "assistant_message", text: "from first" });
    await journal.append(turn.id, { type: "assistant_message", text: "from native follow-up" });
    turn.joined = true;
    turn.terminal = { status: "finished" };
    await journal.save(turn);

    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows.map(({ turnId }) => turnId)).toEqual(Array(4).fill(turn.id));
    expect(rows.map(({ item }) => item)).toEqual([
      turn.user,
      { type: "assistant_message", text: "from first" },
      turn.steers[0].user,
      { type: "assistant_message", text: "from native follow-up" },
    ]);
  });
});

test("a recovered interruption keeps the native prefix committed before the first projection", async () => {
  await withStore(async (root, store, journal) => {
    const runId = "native-before-projection";
    const turn: CursorHistoryTurn = {
      id: "original-turn",
      nativeRunId: runId,
      executionRunIds: [runId],
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "original input", messageId: "original-message" },
      steers: [],
    };
    await journal.admit(turn, turn.user.text);
    await store.runs.create({ run: localRun(runId, "running") });
    const event: sdk.SDKMessage = {
      type: "tool_call",
      run_id: runId,
      agent_id: agentId,
      call_id: "original-tool",
      name: "shell",
      status: "running",
    };
    await store.runEvents.append({
      runId,
      eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
      payload: sdk.createSdkMessageRunStreamEvent(event),
    });
    const assistant: sdk.SDKMessage = {
      type: "assistant",
      run_id: runId,
      agent_id: agentId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "captured before projection" }],
      },
    };
    await store.runEvents.append({
      runId,
      eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
      payload: sdk.createSdkMessageRunStreamEvent(assistant),
    });
    const read = async () =>
      messages(
        await Array.fromAsync(
          readCursorHistory(
            sdk,
            new sdk.JsonlLocalAgentStore(root),
            new CursorTurnJournal(root, agentId),
            agentId,
          ),
        ),
      );
    const before = await read();
    expect(before).toHaveLength(4);
    expect(before[1]).toMatchObject({
      turnId: turn.id,
      item: { callId: `${runId}:original-tool` },
    });
    await store.runs.update({ run: localRun(runId, "cancelled") });
    turn.terminal = { status: "error", message: "The previous run was interrupted." };
    turn.recovered = true;
    turn.joined = true;
    await journal.save(turn);
    const after = await read();
    expect(after).toEqual([
      ...before.slice(0, -1),
      {
        turnId: undefined,
        item: {
          type: "assistant_message",
          text: "[System Error] The previous run was interrupted.",
        },
      },
    ]);
    expect(await read()).toEqual(after);
    expect(await journal.readItems(turn.id)).toEqual([]);
  });
});

test("a recovered terminal answer labels a durable partial projection", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "native-finished-before-projection";
    const turn: CursorHistoryTurn = {
      id: "partial-turn",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "original", messageId: "original-message" },
      steers: [],
      recovered: true,
      joined: true,
      terminal: { status: "finished", fallback: "first second" },
    };
    await journal.admit(turn, "original");
    await journal.append(turn.id, { type: "assistant_message", text: "first" });
    await store.runs.create({ run: { ...localRun(runId, "finished"), result: "first second" } });
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows).toEqual([
      { turnId: turn.id, item: turn.user },
      { turnId: turn.id, item: { type: "assistant_message", text: "first" } },
      {
        turnId: turn.id,
        item: { type: "error", message: expect.stringContaining("Some saved Cursor SDK output") },
      },
    ]);
  });
});

test("keeps a recovered legacy shell journal when only the typed projection changed", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "legacy-shell";
    const input = { command: "echo output", workingDirectory: cwd };
    const output = { status: "success", value: { stdout: "output", stderr: "", exitCode: 0 } };
    const turn: CursorHistoryTurn = {
      id: "paseo-legacy-shell",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "run shell", messageId: "user" },
      steers: [],
      joined: true,
      recovered: true,
      terminal: { status: "finished" },
    };
    await journal.admit(turn, turn.user.text);
    await store.runs.create({ run: localRun(runId, "finished") });
    const append = async (status: "running" | "completed") => {
      const result = status === "completed" ? output : undefined;
      await store.runEvents.append({
        runId,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent({
          type: "tool_call",
          run_id: runId,
          agent_id: agentId,
          call_id: "shell",
          name: "shell",
          status,
          args: input,
          result,
        }),
      });
      await journal.append(turn.id, {
        type: "tool_call",
        callId: runId + ":shell",
        name: "shell",
        status,
        detail: { type: "unknown", input, output: result ?? null },
        error: null,
      });
    };
    await append("running");
    await append("running");
    await append("completed");
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows.every(({ turnId }) => turnId === turn.id)).toBe(true);
    expect(rows.map(({ item }) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "tool_call",
    ]);
  });
});

test("projects a recovered Cursor journal with legacy MCP and search rows", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "legacy-tools";
    const turn: CursorHistoryTurn = {
      id: "paseo-legacy-tools",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "inspect", messageId: "user" },
      steers: [],
      joined: true,
      recovered: true,
      terminal: { status: "finished" },
    };
    await journal.admit(turn, turn.user.text);
    await store.runs.create({ run: localRun(runId, "finished") });
    const cases = [
      {
        name: "mcp",
        args: { providerIdentifier: "custom-user-tools", toolName: "ask_user_question" },
        result: { status: "success", value: { isError: true, content: [] } },
        status: "completed",
      },
      {
        name: "mcp",
        args: { providerIdentifier: "docs", toolName: "lookup_reference" },
        result: { status: "error", value: { message: "transport disconnected" } },
        status: "error",
      },
      {
        name: "glob",
        args: { globPattern: "**/AGENTS.md" },
        result: { status: "success", value: { files: [] } },
        status: "completed",
      },
      {
        name: "read",
        args: { path: "/repo/missing.md" },
        result: { status: "error", error: { message: "error" } },
        status: "completed",
      },
      {
        name: "shell",
        args: { command: "npm test" },
        result: {
          status: "success",
          value: { exitCode: 1, signal: "", stdout: "1 failed", stderr: "", executionTime: 9 },
        },
        status: "completed",
      },
      {
        name: "task",
        args: {
          description: "Review the plan",
          prompt: "Review it",
          subagentType: { kind: "unspecified" },
        },
        result: {
          status: "success",
          value: {
            agentId: "cursor-child",
            conversationSteps: [
              { thinkingMessage: { text: "Reading" } },
              { assistantMessage: { text: "The plan holds." } },
            ],
          },
        },
        status: "completed",
      },
      {
        name: "updateTodos",
        args: { todos: [] },
        result: {
          status: "success",
          value: {
            todos: [
              { content: "Map tools", status: "completed" },
              { content: "Ship it", status: "inProgress" },
              { content: "Dropped", status: "cancelled" },
            ],
            totalCount: 3,
          },
        },
        status: "completed",
      },
    ] as const;
    for (const [index, { name, args, result, status }] of cases.entries()) {
      const callId = String(index);
      await store.runEvents.append({
        runId,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent({
          type: "tool_call",
          run_id: runId,
          agent_id: agentId,
          call_id: callId,
          name,
          status,
          args,
          result,
        }),
      });
      await journal.append(turn.id, {
        type: "tool_call",
        callId: `${runId}:${callId}`,
        name,
        status: status === "error" ? "failed" : "completed",
        detail: { type: "unknown", input: args, output: result },
        error: status === "error" ? result : null,
      });
    }
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows.every(({ turnId }) => turnId === turn.id)).toBe(true);
    expect(rows.map(({ item }) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "todo",
    ]);
    expect(rows.at(-1)?.item).toEqual({
      type: "todo",
      items: [
        { text: "Map tools", completed: true, status: "completed" },
        { text: "Ship it", completed: false, status: "in_progress" },
      ],
    });
    const projected = rows.flatMap(({ item }) => (item.type === "tool_call" ? [item] : []));
    expect(projected.map(buildToolCallDisplayModel)).toEqual([
      { displayName: "Ask question", errorText: "MCP tool returned an error." },
      { displayName: "Lookup reference", errorText: "transport disconnected" },
      { displayName: "Search", summary: "**/AGENTS.md" },
      { displayName: "Read", summary: "/repo/missing.md", errorText: "Read failed." },
      { displayName: "Shell", summary: "npm test", errorText: "Command exited with code 1." },
      { displayName: "Task", summary: "Review the plan" },
    ]);
    expect(projected.map(({ status }) => status)).toEqual([
      "failed",
      "failed",
      "completed",
      "failed",
      "failed",
      "completed",
    ]);
    expect(projected[5].detail).toEqual({
      type: "sub_agent",
      description: "Review the plan",
      log: "The plan holds.",
    });
  });
});

test("deduplicates linked native usage and prefers a newer durable fallback over an older native row", async () => {
  await withStore(async (_root, store, journal) => {
    const first = {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 13,
    };
    await store.runs.create({ run: { ...localRun("first", "finished"), usage: first } });
    await store.runs.create({
      run: {
        ...localRun("followup", "cancelled"),
        turnNumber: 2,
        usage: { ...first, reasoningTokens: 0 },
      },
    });
    const record: CursorHistoryTurn = {
      id: "paseo-first",
      nativeRunId: "first",
      executionRunIds: ["first", "followup"],
      followUpIds: ["followup"],
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "first", messageId: "first" },
      steers: [],
    };
    await journal.admit(record, record.user.text);
    expect(await readCursorLastUsage(store, journal, agentId)).toEqual({
      inputTokens: 20,
      outputTokens: 6,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 26,
      tokenReadingTurnId: record.id,
      reasoningTokens: 0,
    });

    const fallback = { inputTokens: 8, outputTokens: 1, totalTokens: 9, reasoningTokens: 1 };
    await store.runs.create({
      run: { ...localRun("new", "finished"), turnNumber: 3, createdAt: time + 1 },
    });
    await journal.admit(
      {
        ...record,
        id: "paseo-new",
        nativeRunId: "new",
        executionRunIds: ["new"],
        followUpIds: [],
        createdAt: new Date(time + 1).toISOString(),
        lastUsage: fallback,
      },
      "new",
    );
    expect(await readCursorLastUsage(store, journal, agentId)).toEqual({
      ...fallback,
      tokenReadingTurnId: "paseo-new",
    });
  });
});

test("replays a manual compaction from the native stream if the daemon journal missed it", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "native-manual-summary";
    const turn: CursorHistoryTurn = {
      id: "paseo-manual-summary",
      compact: true,
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "/compact", messageId: "command-message" },
      steers: [],
      recovered: true,
      joined: true,
      terminal: { status: "finished", fallback: "stored summary" },
    };
    await journal.admit(turn, "/compact");
    await store.runs.create({ run: { ...localRun(runId, "finished"), result: "stored summary" } });
    for (const status of ["running", "completed"] as const) {
      await store.runEvents.append({
        runId,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent({
          type: "summary",
          run_id: runId,
          agent_id: agentId,
          status,
        }),
      });
    }
    const read = async () =>
      messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    const compaction = { type: "compaction", status: "completed", trigger: "manual" } as const;
    const rows = [
      { turnId: turn.id, item: turn.user },
      { turnId: turn.id, item: compaction },
      { turnId: turn.id, item: { type: "assistant_message", text: "stored summary" } },
    ];
    expect(await read()).toEqual(rows);
    await journal.append(turn.id, compaction);
    expect(await read()).toEqual(rows);
    await journal.append(turn.id, { type: "assistant_message", text: "stored summary" });
    expect(await read()).toEqual(rows);
  });
});

test("replay fails a stamped shell row that completed with a nonzero exit", () => {
  const live = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "shell",
    name: "shell",
    status: "completed",
    args: { command: "false" },
    result: {
      status: "success",
      value: { exitCode: 2, signal: "", stdout: "", stderr: "", executionTime: 1 },
    },
  });
  expect(live).toMatchObject({ status: "failed", error: "Command exited with code 2." });
  // Rows journaled before this rule carry the current stamp but stayed completed.
  const stored: ToolCallTimelineItem = { ...live, status: "completed", error: null };
  expect(replayCursorTool(stored)).toEqual([live]);
  expect(replayCursorTool(live)).toEqual([live]);
});

test("replay keeps a current typed row whose journaled payload was truncated", () => {
  const read = (index: number) => ({
    toolCall: {
      readToolCall: {
        args: { path: `/repo/${index}` },
        result: { success: { content: "x".repeat(4000) } },
      },
    },
  });
  const steps = Array.from({ length: 40 }, (_, index) => read(index));
  const live = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "task",
    name: "task",
    status: "completed",
    args: { description: "Review" },
    result: {
      status: "success",
      value: { conversationSteps: [...steps, { assistantMessage: { text: "Done." } }] },
    },
  });
  const stored = limitAgentTimelineItemContent(live) as ToolCallTimelineItem;
  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(live).length);
  expect(stored.detail).toEqual({ type: "sub_agent", description: "Review", log: "Done." });
  expect(replayCursorTool(stored)).toEqual([stored]);
});

test("maps the remaining Cursor tools to typed cards", () => {
  const call = (name: string, args: unknown, value?: unknown) =>
    mapCursorTool({
      type: "tool_call",
      agent_id: agentId,
      run_id: "run",
      call_id: name,
      name,
      status: value === undefined ? "running" : "completed",
      args,
      ...(value === undefined ? {} : { result: { status: "success", value } }),
    });
  const grep = call(
    "grep",
    { pattern: "TODO" },
    {
      workspaceResults: {
        "/repo": {
          type: "content",
          output: { matches: [{ file: "a.ts", lineNumber: 3, line: "// TODO" }], totalMatches: 1 },
        },
      },
    },
  );
  const glob = call(
    "glob",
    { globPattern: "*.md" },
    { files: ["README.md"], totalFiles: 1, clientTruncated: false, ripgrepTruncated: true },
  );
  const ls = call(
    "ls",
    { path: "/repo" },
    {
      directoryTreeRoot: {
        absPath: "/repo",
        childrenDirs: [
          { absPath: "/repo/src", childrenDirs: [], childrenFiles: [{ name: "a.ts" }] },
        ],
        childrenFiles: [{ name: "README.md" }],
      },
    },
  );
  const lints = call(
    "readLints",
    { paths: ["a.ts"] },
    {
      fileDiagnostics: [
        {
          path: "a.ts",
          diagnostics: [
            {
              severity: "error",
              range: { start: { line: 2, character: 4 } },
              message: "Unused",
              source: "ts",
              code: "6133",
            },
          ],
        },
      ],
    },
  );
  const edit = call("edit", { path: "a.ts", oldText: "a", newText: "b" });
  expect([grep, glob, ls, lints, edit].map(({ detail }) => detail)).toEqual([
    {
      type: "search",
      query: "TODO",
      toolName: "grep",
      content: "a.ts:3:// TODO",
      numFiles: 1,
      numMatches: 1,
      mode: "content",
    },
    {
      type: "search",
      query: "*.md",
      toolName: "glob",
      filePaths: ["README.md"],
      numFiles: 1,
      truncated: true,
    },
    { type: "plain_text", label: "/repo", icon: "search", text: "src/\n  a.ts\nREADME.md" },
    { type: "plain_text", label: "a.ts", icon: "eye", text: "a.ts:3:5 error: Unused (ts 6133)" },
    { type: "edit", filePath: "a.ts", oldString: "a", newString: "b" },
  ]);
  expect(
    [
      call("semSearch", { query: "where is auth" }, { results: "src/auth.ts" }),
      call("createPlan", { plan: "1. Map tools" }, {}),
      call("delete", { path: "old.ts" }, { fileSize: 3 }),
      ls,
      lints,
    ].map(buildToolCallDisplayModel),
  ).toEqual([
    { displayName: "Search", summary: "where is auth" },
    { displayName: "Plan" },
    { displayName: "Delete", summary: "old.ts" },
    { displayName: "List directory", summary: "/repo" },
    { displayName: "Read lints", summary: "a.ts" },
  ]);
  expect(cursorTimelineItems(call("updateTodos", { todos: [] }))).toEqual([]);
});

test("shows a generated image after its row, once, live and on replay", () => {
  const description = `Two phone layouts\n\n${"Dark, quiet chrome. ".repeat(12)}`;
  const args = { description, filePath: "assets/layouts.jpg" };
  const result = { status: "success", value: { filePath: "/repo/assets/layouts.jpg" } };
  const live = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "image",
    name: "generateImage",
    status: "completed",
    args,
    result,
  });
  const image = {
    type: "assistant_message",
    text: "\n\n![Generated image](file:///repo/assets/layouts.jpg)\n\n",
  };
  expect(cursorTimelineItems(live)).toEqual([live, image]);
  expect(live.detail).toEqual({
    type: "plain_text",
    icon: "sparkles",
    label: description.trim(),
    text: description.trim(),
  });
  expect(buildToolCallDisplayModel(live).displayName).toBe("Generate image");
  // The journal already holds the image written beside a current row.
  expect(replayCursorTool(live)).toEqual([live]);
  const legacy: ToolCallTimelineItem = {
    type: "tool_call",
    callId: "run:image",
    name: "generateImage",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: args, output: result },
  };
  expect(replayCursorTool(legacy)).toEqual([live, image]);
  // A row that stays untyped is stamped too, so replay does not add its image again.
  const untyped = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "untyped",
    name: "generateImage",
    status: "completed",
    args: "draw",
    result,
  });
  expect(untyped.detail.type).toBe("unknown");
  expect(cursorTimelineItems(untyped)).toHaveLength(2);
  expect(replayCursorTool(untyped)).toEqual([untyped]);
});

test("a failed Cursor call shows its error text, live and on replay", () => {
  const live = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "read",
    name: "read",
    status: "error",
    args: { path: "/repo/a.md" },
    result: { status: "error", error: { message: "permission denied" } },
  });
  expect(live).toMatchObject({ status: "failed", error: "permission denied" });
  // Rows journaled before this rule kept the raw result as their error.
  const stored = { ...live, error: { status: "error", error: { message: "permission denied" } } };
  expect(replayCursorTool(stored)).toEqual([live]);
  const bare = mapCursorTool({
    type: "tool_call",
    agent_id: agentId,
    run_id: "run",
    call_id: "bare",
    name: "read",
    status: "error",
    args: { path: "/repo/a.md" },
    result: { message: "EACCES" },
  });
  expect(bare.error).toBe("EACCES");
});

test("a recovered turn whose journal truncated a large tool row still matches", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "large-shell";
    const turn: CursorHistoryTurn = {
      id: "paseo-large-shell",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "run shell", messageId: "user" },
      steers: [],
      joined: true,
      recovered: true,
      terminal: { status: "finished" },
    };
    await journal.admit(turn, turn.user.text);
    await store.runs.create({ run: localRun(runId, "finished") });
    const stdout = "x".repeat(200_000);
    let previous: ToolCallTimelineItem | undefined;
    for (const status of ["running", "completed"] as const) {
      const message = {
        type: "tool_call" as const,
        run_id: runId,
        agent_id: agentId,
        call_id: "shell",
        name: "shell",
        status,
        args: { command: "cat big.log" },
        ...(status === "completed"
          ? { result: { status: "success", value: { exitCode: 0, stdout, stderr: "" } } }
          : {}),
      };
      await store.runEvents.append({
        runId,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent(message),
      });
      previous = mapCursorTool(message, previous);
      await journal.append(turn.id, limitAgentTimelineItemContent(previous));
    }
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows.map(({ item }) => item.type)).toEqual(["user_message", "tool_call", "tool_call"]);
  });
});

test("a steer keeps its place when replay expands or drops journaled rows", async () => {
  await withStore(async (_root, store, journal) => {
    const runId = "steered-todos";
    const steer = { type: "user_message" as const, text: "also this", messageId: "steer" };
    const turn: CursorHistoryTurn = {
      id: "paseo-steered-todos",
      nativeRunId: runId,
      createdAt: new Date(time).toISOString(),
      user: { type: "user_message", text: "plan", messageId: "user" },
      steers: [{ user: steer, after: 2 }],
      joined: true,
      terminal: { status: "finished" },
    };
    await journal.admit(turn, turn.user.text);
    await store.runs.create({ run: localRun(runId, "finished") });
    const todos = { status: "success", value: { todos: [{ content: "Plan", status: "pending" }] } };
    // Legacy rows: the running one replays as nothing, the completed one as a task list.
    for (const [status, output] of [
      ["running", null],
      ["completed", todos],
    ] as const) {
      await journal.append(turn.id, {
        type: "tool_call",
        callId: `${runId}:todos`,
        name: "updateTodos",
        status,
        error: null,
        detail: { type: "unknown", input: { todos: [] }, output },
      });
    }
    await journal.append(turn.id, { type: "assistant_message", text: "after the steer" });
    const rows = messages(await Array.fromAsync(readCursorHistory(sdk, store, journal, agentId)));
    expect(rows.map(({ item }) => item)).toEqual([
      turn.user,
      { type: "todo", items: [{ text: "Plan", completed: false, status: "pending" }] },
      steer,
      { type: "assistant_message", text: "after the steer" },
    ]);
  });
});

test("shows computer use and screen recording as cards, with the screenshot inline", () => {
  const tool = (name: string, args: unknown, result: unknown): ToolCallTimelineItem =>
    mapCursorTool({
      type: "tool_call",
      agent_id: agentId,
      run_id: "run",
      call_id: name,
      name,
      status: "completed",
      args,
      result,
    });
  const actions = [
    { type: "click", coordinate: { x: 10, y: 20 }, button: "left", count: 2 },
    { type: "type", text: "hello" },
    { type: "key", key: "Enter", stroke: "tap" },
    { type: "click", coordinate: { x: 5, y: 6 }, button: "left", count: 1, modifierKeys: "cmd" },
    { type: "key", key: "Shift", stroke: "down", holdDurationMs: 300 },
    { type: "mouseDown", button: "right" },
    { type: "key", key: "Shift", stroke: "up" },
    { type: "scroll", direction: "down", amount: 3, modifierKeys: "shift" },
    {
      type: "drag",
      path: [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
      ],
      button: "middle",
      modifierKeys: "alt",
    },
    { type: "screenshot" },
  ];
  const clickedArgs = { actions, description: "Submit the form" };
  const clickedResult = {
    status: "success",
    value: { actionCount: 10, durationMs: 900, screenshotPath: "/tmp/after.png", log: "ok" },
  };
  const clicked = tool("computerUse", clickedArgs, clickedResult);
  const screenshot = {
    type: "assistant_message",
    text: "\n\n![Screenshot](file:///tmp/after.png)\n\n",
  };
  expect(cursorTimelineItems(clicked)).toEqual([clicked, screenshot]);
  expect(clicked.detail).toEqual({
    type: "plain_text",
    icon: "wrench",
    label: "Submit the form",
    text: [
      "click x2 (10, 20)",
      'type "hello"',
      "key Enter",
      "cmd+click (5, 6)",
      "key down Shift held 300 ms",
      "mouseDown right",
      "key up Shift",
      "shift+scroll down 3",
      "alt+drag middle (1, 1) -> (9, 9)",
      "screenshot",
      "",
      "ok",
    ].join("\n"),
  });
  const missed = tool(
    "computerUse",
    { actions: [{ type: "click", coordinate: { x: 1, y: 2 }, button: "right", count: 1 }] },
    {
      status: "error",
      error: {
        message: "Window closed",
        actionCount: 0,
        durationMs: 5,
        screenshotPath: "/tmp/x.png",
      },
    },
  );
  expect(missed).toMatchObject({ status: "failed", error: "Window closed" });
  expect(missed.detail).toMatchObject({ label: "click right (1, 2)" });
  expect(cursorTimelineItems(missed)).toHaveLength(2);
  const saved = tool(
    "recordScreen",
    { mode: "SAVE_RECORDING" },
    { status: "success", value: { path: "/tmp/demo.mp4", recordingDurationMs: 4200 } },
  );
  expect(saved.detail).toEqual({
    type: "plain_text",
    icon: "eye",
    label: "Save recording",
    text: "/tmp/demo.mp4\n4.2 s",
  });
  expect([clicked, saved].map((item) => buildToolCallDisplayModel(item).displayName)).toEqual([
    "Computer use",
    "Record screen",
  ]);
  // A row journaled before these cards existed gains the card and the screenshot.
  const legacy: ToolCallTimelineItem = {
    type: "tool_call",
    callId: clicked.callId,
    name: "computerUse",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: clickedArgs, output: clickedResult },
  };
  expect(replayCursorTool(legacy)).toEqual([clicked, screenshot]);
});
