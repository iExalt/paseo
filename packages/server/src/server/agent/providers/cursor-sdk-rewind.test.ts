import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { readCursorHistory, type HistorySdk } from "./cursor-sdk-history.js";
import { CursorForkLinks, withCursorForkBlobs } from "./cursor-sdk-fork-store.js";
import { CursorRewindError, forkCursorConversation } from "./cursor-sdk-rewind.js";
import {
  CursorTurnJournal,
  cursorInstructionsInWindow,
  type CursorHistoryTurn,
} from "./cursor-sdk-turn-journal.js";

const agentId = "agent-source";
const cwd = "/workspace";
const time = Date.parse("2026-11-20T10:00:00Z");
const ref = (rootBlobId: string) => ({ schemaVersion: 1 as const, rootBlobId });

interface Fixture {
  root: string;
  raw: sdk.LocalAgentStore;
  store: sdk.LocalAgentStore;
  links: CursorForkLinks;
  journal: CursorTurnJournal;
  listed: string[];
  historySdk: (fail?: Error) => HistorySdk;
}

async function withStore(callback: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-rewind-"));
  const raw = new sdk.JsonlLocalAgentStore(root);
  const links = new CursorForkLinks(root);
  const store = withCursorForkBlobs(raw, links);
  const listed: string[] = [];
  const historySdk = (fail?: Error): HistorySdk => ({
    ...sdk,
    Agent: {
      messages: {
        // The SDK decrypts the checkpoint chain here. Live proof covers real blobs.
        list: async (id: string) => {
          listed.push(id);
          if (fail && id !== agentId) throw fail;
          return [];
        },
      },
    } as unknown as HistorySdk["Agent"],
  });
  try {
    await store.agents.create({
      agent: {
        agentId,
        cwd,
        status: "idle",
        name: "Source",
        createdAt: time,
        updatedAt: time,
        latestCheckpoint: ref("blob-3"),
        sdkMetadata: { blobEncryptionKey: "key" },
      },
    });
    for (const blobId of ["blob-1", "blob-2", "blob-3"]) {
      await store.checkpoints.create({ agentId, blobId, data: new TextEncoder().encode(blobId) });
    }
    await callback({
      root,
      raw,
      store,
      links,
      journal: new CursorTurnJournal(root, agentId),
      listed,
      historySdk,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function run(
  turnNumber: number,
  start: string | null,
  latest: string | null,
  status: sdk.LocalAgentRunStatus = "finished",
): sdk.LocalAgentRunDocument {
  return {
    agentId,
    runId: `run-${turnNumber}`,
    turnNumber,
    status,
    createdAt: time + turnNumber * 1000,
    updatedAt: time + turnNumber * 1000,
    startedAt: status === "cancelled" ? null : time + turnNumber * 1000,
    endedAt: time + turnNumber * 1000 + 500,
    startCheckpointRef: start ? ref(start) : null,
    latestCheckpointRef: latest ? ref(latest) : null,
  };
}

async function addTurn(
  { store, journal }: Fixture,
  native: sdk.LocalAgentRunDocument,
  text: string,
  steer?: string,
): Promise<CursorHistoryTurn> {
  await store.runs.create({ run: native });
  const turn: CursorHistoryTurn = {
    id: `turn-${native.turnNumber}`,
    nativeRunId: native.runId,
    createdAt: new Date(native.createdAt).toISOString(),
    user: { type: "user_message", text, messageId: `message-${native.turnNumber}` },
    steers: steer
      ? [
          {
            user: { type: "user_message", text: steer, messageId: `steer-${native.turnNumber}` },
            after: 1,
          },
        ]
      : [],
    joined: true,
    terminal: { status: "finished" },
  };
  await journal.admit(turn, text);
  await journal.append(turn.id, { type: "assistant_message", text: `reply ${native.turnNumber}` });
  await journal.save(turn);
  return turn;
}

async function threeTurns(fixture: Fixture) {
  await addTurn(fixture, run(1, null, "blob-1"), "first");
  await addTurn(fixture, run(2, "blob-1", "blob-2"), "second", "nudge");
  await addTurn(fixture, run(3, "blob-2", "blob-3"), "third");
}

async function timeline(history: HistorySdk, fixture: Fixture, id: string) {
  const events: AgentStreamEvent[] = await Array.fromAsync(
    readCursorHistory(history, fixture.store, fixture.journal.forAgent(id), id),
  );
  return events.flatMap((event) =>
    event.type === "timeline" ? [{ turnId: event.turnId, item: event.item }] : [],
  );
}

async function snapshot(root: string) {
  const files = ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"];
  return Promise.all(files.map((name) => readFile(join(root, name), "utf8").catch(() => "")));
}

test("forks the conversation before a prompt and leaves the source chat intact", async () => {
  await withStore(async (fixture) => {
    await threeTurns(fixture);
    const { store, journal } = fixture;
    const [first] = await journal.read();
    await journal.save({ ...first, instructionsHash: "instructions" });
    const history = fixture.historySdk();
    const sourceHistory = await timeline(history, fixture, agentId);
    const sourceAgent = await store.agents.get({ agentId });
    const sourceRuns = (await store.runs.list({ filter: { agentIds: [agentId] } })).items;
    const sourceTurns = await journal.read();

    const fork = await forkCursorConversation({
      sdk: history,
      links: fixture.links,
      store,
      journal,
      agentId,
      messageId: "message-3",
    });

    const forked = await store.agents.get({ agentId: fork.agentId });
    expect(forked).toMatchObject({
      cwd,
      name: "Source",
      status: "idle",
      activeRunId: null,
      latestCheckpoint: ref("blob-2"),
      sdkMetadata: { blobEncryptionKey: "key" },
    });
    expect(fixture.listed).toContain(fork.agentId);
    const forkRuns = (await store.runs.list({ filter: { agentIds: [fork.agentId] } })).items;
    expect(forkRuns.map((r) => r.turnNumber)).toEqual([1, 2]);
    const sourceRunIds = new Set(sourceRuns.map((r) => r.runId));
    expect(forkRuns.filter((r) => sourceRunIds.has(r.runId))).toEqual([]);
    // The fork reads the source's blobs through its link instead of copying them.
    expect((await store.checkpoints.list({ filter: { agentIds: [fork.agentId] } })).items).toEqual([
      "blob-1",
      "blob-2",
      "blob-3",
    ]);
    expect(
      (await fixture.raw.checkpoints.list({ filter: { agentIds: [fork.agentId] } })).items,
    ).toEqual([]);
    for (const forkRun of forkRuns) {
      const events = await store.runEvents.list({ runId: forkRun.runId });
      expect(events.items).toEqual([]);
    }
    // The fork shows exactly the turns before the selected prompt, steers included.
    const forkHistory = await timeline(history, fixture, fork.agentId);
    expect(forkHistory).toEqual(sourceHistory.filter((row) => row.turnId !== "turn-3"));
    expect(forkHistory.map((row) => row.item)).toContainEqual(
      expect.objectContaining({ messageId: "steer-2" }),
    );
    // The fork keeps the delivered instructions in its context window.
    const forkTurns = await journal.forAgent(fork.agentId).read();
    expect(cursorInstructionsInWindow(forkTurns, "next")).toBe("instructions");

    expect(await store.agents.get({ agentId })).toEqual(sourceAgent);
    expect((await store.runs.list({ filter: { agentIds: [agentId] } })).items).toEqual(sourceRuns);
    expect(await journal.read()).toEqual(sourceTurns);
    expect(await timeline(history, fixture, agentId)).toEqual(sourceHistory);
  });
});

test("rewinds the first prompt to an empty conversation after the reserved SDK run", async () => {
  await withStore(async (fixture) => {
    // Resume cancels the SDK's reserved first run, so the first prompt is turn 2.
    await fixture.store.runs.create({ run: run(1, null, null, "cancelled") });
    await addTurn(fixture, run(2, null, "blob-1"), "first");
    await addTurn(fixture, run(3, "blob-1", "blob-2"), "second");
    const history = fixture.historySdk();

    const fork = await forkCursorConversation({
      sdk: history,
      links: fixture.links,
      store: fixture.store,
      journal: fixture.journal,
      agentId,
      messageId: "message-2",
    });

    const forked = await fixture.store.agents.get({ agentId: fork.agentId });
    expect(forked?.latestCheckpoint).toBeNull();
    const forkRuns = (await fixture.store.runs.list({ filter: { agentIds: [fork.agentId] } }))
      .items;
    expect(forkRuns.map((r) => [r.turnNumber, r.status])).toEqual([[1, "cancelled"]]);
    expect(await timeline(history, fixture, fork.agentId)).toEqual([]);
  });
});

test("resolves a legacy native prompt from the projected history", async () => {
  await withStore(async (fixture) => {
    const { store } = fixture;
    await store.runs.create({ run: run(1, null, "blob-1") });
    await store.runs.create({ run: run(2, "blob-1", "blob-2") });
    for (const native of ["run-1", "run-2"]) {
      await store.runEvents.append({
        runId: native,
        eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
        payload: sdk.createSdkMessageRunStreamEvent({
          type: "user",
          run_id: native,
          agent_id: agentId,
          message: { role: "user", content: [{ type: "text", text: `prompt ${native}` }] },
        }),
      });
    }
    const history = fixture.historySdk();

    const fork = await forkCursorConversation({
      sdk: history,
      links: fixture.links,
      store,
      journal: fixture.journal,
      agentId,
      messageId: "run-2:user",
    });

    expect((await store.agents.get({ agentId: fork.agentId }))?.latestCheckpoint).toEqual(
      ref("blob-1"),
    );
    expect(await timeline(history, fixture, fork.agentId)).toMatchObject([
      { item: { type: "user_message", text: "prompt run-1", messageId: expect.any(String) } },
    ]);
  });
});

test.each([
  ["a follow-up sent during a turn", "steer-2", undefined, /only to a message that started a turn/],
  ["an unknown message", "missing", undefined, /could not find this message/],
  [
    "a checkpoint the store no longer holds",
    "message-3",
    async ({ store }: Fixture) =>
      store.checkpoints.delete({ filter: { agentIds: [agentId], blobIds: ["blob-2"] } }),
    /no longer stored/,
  ],
  [
    "a run the SDK did not checkpoint",
    "message-3",
    async ({ store }: Fixture) => {
      const native = await store.runs.get({ agentId, runId: "run-3" });
      await store.runs.update({ run: { ...native!, startCheckpointRef: null } });
    },
    /did not record a checkpoint/,
  ],
])("leaves the chat unchanged when rewinding to %s", async (_name, messageId, mutate, message) => {
  await withStore(async (fixture) => {
    await threeTurns(fixture);
    await mutate?.(fixture);
    const before = await snapshot(fixture.root);

    await expect(
      forkCursorConversation({
        sdk: fixture.historySdk(),
        links: fixture.links,
        store: fixture.store,
        journal: fixture.journal,
        agentId,
        messageId,
      }),
    ).rejects.toThrow(message);
    expect(await snapshot(fixture.root)).toEqual(before);
  });
});

test("removes a fork whose conversation the SDK cannot load", async () => {
  await withStore(async (fixture) => {
    await threeTurns(fixture);
    const { store } = fixture;
    const sourceAgent = await store.agents.get({ agentId });
    const sourceRuns = (await store.runs.list({ filter: { agentIds: [agentId] } })).items;

    const failure = forkCursorConversation({
      sdk: fixture.historySdk(new Error("cannot decrypt")),
      links: fixture.links,
      store,
      journal: fixture.journal,
      agentId,
      messageId: "message-3",
      newAgentId: "agent-fork",
    });

    await expect(failure).rejects.toBeInstanceOf(CursorRewindError);
    await expect(failure).rejects.toThrow(/could not recover the conversation.*cannot decrypt/);
    expect(await store.agents.get({ agentId: "agent-fork" })).toBeNull();
    expect((await store.runs.list({ filter: { agentIds: ["agent-fork"] } })).items).toEqual([]);
    expect((await store.checkpoints.list({ filter: { agentIds: ["agent-fork"] } })).items).toEqual(
      [],
    );
    expect(await fixture.journal.forAgent("agent-fork").read()).toEqual([]);
    expect(await store.agents.get({ agentId })).toEqual(sourceAgent);
    expect((await store.runs.list({ filter: { agentIds: [agentId] } })).items).toEqual(sourceRuns);
  });
});

test("rewinds a rewound chat again through its chain of forks", async () => {
  await withStore(async (fixture) => {
    await threeTurns(fixture);
    const { root, raw, store } = fixture;
    const history = fixture.historySdk();
    const first = await forkCursorConversation({
      sdk: history,
      links: fixture.links,
      store,
      journal: fixture.journal,
      agentId,
      messageId: "message-3",
    });

    const second = await forkCursorConversation({
      sdk: history,
      links: fixture.links,
      store,
      journal: first.journal,
      agentId: first.agentId,
      messageId: "message-2",
    });

    expect((await store.agents.get({ agentId: second.agentId }))?.latestCheckpoint).toEqual(
      ref("blob-1"),
    );
    expect((await timeline(history, fixture, second.agentId)).map((row) => row.turnId)).toEqual([
      "turn-1",
      "turn-1",
    ]);
    // A daemon restart reads the links from disk.
    const reopened = withCursorForkBlobs(raw, new CursorForkLinks(root));
    const text = (data: Uint8Array | null) => data && new TextDecoder().decode(data);
    expect(
      text(await reopened.checkpoints.get({ agentId: second.agentId, blobId: "blob-3" })),
    ).toBe("blob-3");
    // The SDK saves a blob it already read through an ancestor with update().
    const data = new TextEncoder().encode("rewritten");
    await reopened.checkpoints.update({ agentId: second.agentId, blobId: "blob-1", data });
    expect(text(await raw.checkpoints.get({ agentId: second.agentId, blobId: "blob-1" }))).toBe(
      "rewritten",
    );
    expect(text(await raw.checkpoints.get({ agentId, blobId: "blob-1" }))).toBe("blob-1");
  });
});

test("removes a fork that fails before its agent row is written", async () => {
  await withStore(async (fixture) => {
    await threeTurns(fixture);
    const { root, raw, store } = fixture;
    const sourceRuns = (await raw.runs.list({ filter: { agentIds: [agentId] } })).items;
    const failing: sdk.LocalAgentStore = {
      ...store,
      agents: {
        get: (input) => store.agents.get(input),
        update: (input) => store.agents.update(input),
        delete: (input) => store.agents.delete(input),
        list: (input) => store.agents.list(input),
        create: async () => {
          throw new Error("disk full");
        },
      },
    };

    await expect(
      forkCursorConversation({
        sdk: fixture.historySdk(),
        links: fixture.links,
        store: failing,
        journal: fixture.journal,
        agentId,
        messageId: "message-3",
        newAgentId: "agent-fork",
      }),
    ).rejects.toThrow(/could not recover the conversation.*disk full/);

    expect((await raw.runs.list({ filter: { agentIds: ["agent-fork"] } })).items).toEqual([]);
    expect(await new CursorForkLinks(root).lineage("agent-fork")).toEqual(["agent-fork"]);
    expect(await fixture.journal.forAgent("agent-fork").read()).toEqual([]);
    expect((await raw.runs.list({ filter: { agentIds: [agentId] } })).items).toEqual(sourceRuns);
  });
});
