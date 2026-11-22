import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { readCursorHistory } from "./cursor-sdk-history.js";
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
