import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CursorForkLinks, withCursorForkBlobs } from "./cursor-sdk-fork-store.js";
import {
  closeCursorSdkStores,
  migrateCursorSdkStore,
  openCursorSdkStore,
} from "./cursor-sdk-store.js";

const time = Date.parse("2026-11-20T10:00:00Z");
const blobId = (n: number) => createHash("sha256").update(`blob-${n}`).digest("hex");
const ref = (n: number) => ({ schemaVersion: 1 as const, rootBlobId: blobId(n) });
const legacyTables = ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"];

let root: string;
let errors: unknown[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cursor-sdk-store-"));
  errors = [];
});

afterEach(async () => {
  await closeCursorSdkStores();
  await rm(root, { recursive: true, force: true });
});

function open() {
  return openCursorSdkStore({
    root,
    openLegacy: () => new sdk.JsonlLocalAgentStore(root),
    onMigrationError: (error) => errors.push(error),
  });
}

async function reopen() {
  await closeCursorSdkStores();
  return open();
}

function run(agentId: string, runId: string, turnNumber: number, status: "finished" | "error") {
  return {
    runId,
    requestId: `request-${runId}`,
    agentId,
    turnNumber,
    status,
    model: { id: "composer-2", params: [{ id: "reasoning_effort", value: "high" }] },
    result: status === "finished" ? "done" : null,
    error: status === "error" ? "The previous Cursor SDK run was interrupted." : null,
    usageRef: null,
    usage: null,
    createdAt: time + turnNumber,
    // An errored run can be updated after it ended.
    updatedAt: time + turnNumber + (status === "error" ? 60 : 50),
    startedAt: time + turnNumber,
    endedAt: time + turnNumber + 50,
    startCheckpointRef: ref(turnNumber - 1),
    latestCheckpointRef: ref(turnNumber),
  };
}

/** A JSONL store shaped like a real one: a chat with turns, interleaved events and a rewound fork. */
async function seedLegacy() {
  const legacy = new sdk.JsonlLocalAgentStore(root);
  const links = new CursorForkLinks(root);
  for (const agentId of ["agent-source", "agent-fork"]) {
    await legacy.agents.create({
      agent: {
        agentId,
        cwd: "/workspace",
        status: "idle",
        activeRunId: null,
        name: agentId,
        createdAt: time,
        updatedAt: time + 100,
        latestCheckpoint: ref(2),
        sdkMetadata: { blobEncryptionKey: `key-${agentId}` },
      },
    });
  }
  await legacy.runs.create({ run: run("agent-source", "run-1", 1, "finished") });
  await legacy.runs.create({ run: run("agent-source", "run-2", 2, "error") });
  // JSONL agents.delete removed only the agent row of a deleted chat.
  await legacy.runs.create({ run: run("agent-deleted", "run-orphan", 1, "finished") });
  await legacy.runEvents.append({ runId: "run-orphan", eventType: "run_stream_event" });
  for (let i = 0; i < 3; i++) {
    for (const runId of ["run-1", "run-2"]) {
      await legacy.runEvents.append({
        runId,
        eventType: "run_stream_event",
        payload: { text: `${runId} part ${i}`, nested: { i } },
        idempotencyKey: i === 0 ? `${runId}-first` : null,
      });
    }
  }
  for (const n of [0, 1, 2]) {
    await legacy.checkpoints.create({
      agentId: "agent-source",
      blobId: blobId(n),
      data: Buffer.from(`checkpoint ${n}`),
    });
  }
  // A fork stores only the blobs it writes and reads the rest through its parent.
  await legacy.checkpoints.create({
    agentId: "agent-fork",
    blobId: blobId(3),
    data: Buffer.from("fork checkpoint"),
  });
  await links.link("agent-fork", "agent-source");
}

async function snapshot() {
  return Promise.all(legacyTables.map((name) => readFile(join(root, name), "utf8")));
}

test("migrates every JSONL row into SQLite and leaves the JSONL tables untouched", async () => {
  await seedLegacy();
  const before = await snapshot();
  const store = withCursorForkBlobs(await open(), new CursorForkLinks(root));

  expect(errors).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect((await store.agents.get({ agentId: "agent-source" }))?.sdkMetadata).toEqual({
    blobEncryptionKey: "key-agent-source",
  });
  expect(await store.runs.get({ agentId: "agent-source", runId: "run-2" })).toMatchObject({
    status: "error",
    error: "The previous Cursor SDK run was interrupted.",
    endedAt: time + 62,
  });
  const events = await store.runEvents.list({ runId: "run-2", limit: 10 });
  expect(events.items.map((event) => [event.seq, event.payload])).toEqual([
    [1, { text: "run-2 part 0", nested: { i: 0 } }],
    [2, { text: "run-2 part 1", nested: { i: 1 } }],
    [3, { text: "run-2 part 2", nested: { i: 2 } }],
  ]);
  expect(events.items[0]?.idempotencyKey).toBe("run-2-first");
  const inherited = await store.checkpoints.get({ agentId: "agent-fork", blobId: blobId(1) });
  expect(Buffer.from(inherited!).toString()).toBe("checkpoint 1");
  expect(await store.runs.get({ agentId: "agent-deleted", runId: "run-orphan" })).toBeNull();
  expect(await readdir(root)).not.toContain("sqlite.staging");
  expect(
    JSON.parse(await readFile(join(root, "sqlite", "paseo-migration.json"), "utf8")).counts,
  ).toMatchObject({ runs: 2, runEvents: 6, orphanRuns: 1, orphanRunEvents: 1 });
});

test("waits for another process's migration instead of serving the JSONL store", async () => {
  await seedLegacy();
  const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
  let locked!: () => void;
  const lockHeld = new Promise<void>((resolve) => (locked = resolve));
  // The other migration holds its lock while this process opens the store.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const migrating = migrateCursorSdkStore(root, async (stateRoot) => {
    locked();
    await released;
    return SqliteLocalAgentStore.open({ workspaceRef: "paseo", stateRoot });
  });
  await lockHeld;
  const opening = open();
  // Give the opener time to find the lock held; if it is slower, the test still passes.
  setTimeout(release, 300);

  const [store] = await Promise.all([opening, migrating]);

  expect(errors).toEqual([]);
  expect(store).not.toBeInstanceOf(sdk.JsonlLocalAgentStore);
  expect(await store.runs.get({ agentId: "agent-source", runId: "run-1" })).not.toBeNull();
});

test("stops retrying a migration after three failures", async () => {
  await seedLegacy();
  await writeFile(join(root, "sqlite.migration-failures"), "3\n");

  const store = await open();

  expect(store).toBeInstanceOf(sdk.JsonlLocalAgentStore);
  expect(String(errors[0])).toContain(join(root, "sqlite.migration-failures"));
  expect(await readdir(root)).not.toContain("sqlite");
});

test("opens the migrated store without migrating again", async () => {
  await seedLegacy();
  await open();
  await new sdk.JsonlLocalAgentStore(root).runs.create({
    run: run("agent-source", "run-late", 3, "finished"),
  });

  const store = await reopen();

  expect(await store.runs.get({ agentId: "agent-source", runId: "run-late" })).toBeNull();
});

test("finishes a migration that a crash interrupted", async () => {
  await seedLegacy();
  await mkdir(join(root, "sqlite.staging", "agents"), { recursive: true });
  await writeFile(join(root, "sqlite.staging", "index.db"), "half-written");
  await mkdir(join(root, "sqlite"), { recursive: true });
  // A process ID that is never alive.
  await writeFile(join(root, "sqlite.lock"), "2147483646\n");

  const store = await open();

  expect(errors).toEqual([]);
  expect((await store.runs.list({ filter: { agentIds: ["agent-source"] } })).items).toHaveLength(2);
});

test("keeps serving the JSONL store when the migrated copy would renumber events", async () => {
  await seedLegacy();
  const events = (await readFile(join(root, "run_events.ndjson"), "utf8")).trim().split("\n");
  // Drop run-1's second event so its third arrives with seq 3 and would become seq 2.
  const gap = events.filter((line) => !(line.includes('"run-1"') && line.includes('"seq":2')));
  await writeFile(join(root, "run_events.ndjson"), `${gap.join("\n")}\n`);

  const store = await open();

  expect(String(errors[0])).toContain("renumbered run-1 event 3 as 2");
  expect(store).toBeInstanceOf(sdk.JsonlLocalAgentStore);
  expect(await readdir(root)).not.toContain("sqlite");
  expect(await readFile(join(root, "sqlite.migration-failures"), "utf8")).toBe("1\n");
});

test("fails a checkpoint write that SQLite could only keep in memory", async () => {
  const store = await open();
  await store.agents.create({
    agent: {
      agentId: "agent-new",
      cwd: "/workspace",
      status: "idle",
      activeRunId: null,
      name: null,
      createdAt: time,
      updatedAt: time,
      latestCheckpoint: null,
      sdkMetadata: {},
    },
  });
  // A directory where the chat's database file belongs makes SQLite fail to open it.
  const agentDirectory = `agent-${createHash("sha256").update("agent-new").digest("hex")}`;
  await mkdir(join(root, "sqlite", "agents", agentDirectory, "store.db"), { recursive: true });

  await expect(
    store.checkpoints.create({ agentId: "agent-new", blobId: blobId(9), data: Buffer.from("x") }),
  ).rejects.toThrow("could not persist checkpoints for agent-new");
});
