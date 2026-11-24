import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import type { LocalAgentDocument, LocalAgentRunDocument, LocalAgentStore } from "@cursor/sdk";

/**
 * Paseo's Cursor SDK local store.
 *
 * Cursor SDK 1.4.2's JsonlLocalAgentStore reads and parses a whole table file on
 * every get, and rewrites it on every write. A 129 MB checkpoint table made each
 * blob read parse 129 MB, which ran the daemon out of heap. Paseo keeps the
 * SDK's SQLite store under `sqlite/` instead and migrates the JSONL tables into
 * it once. The JSONL files stay untouched: an older daemon still opens the chats
 * as they were at migration time, and a failed migration keeps serving them.
 */

const SQLITE_DIRECTORY = "sqlite";
const STAGING_DIRECTORY = "sqlite.staging";
const LOCK_FILE = "sqlite.lock";
const FAILURES_FILE = "sqlite.migration-failures";
const MARKER = "paseo-migration.json";
const WORKSPACE_REF = "paseo";
const MAX_MIGRATION_ATTEMPTS = 3;
const LEGACY_TABLES = {
  agents: "agents.ndjson",
  runs: "runs.ndjson",
  runEvents: "run_events.ndjson",
  checkpoints: "checkpoints.ndjson",
} as const;

export interface CursorStoreMigration {
  fresh: boolean;
  migratedAt: string;
  counts: { agents: number; runs: number; runEvents: number; checkpoints: number };
}

export interface SqliteCursorStore extends LocalAgentStore {
  dispose(): Promise<void>;
}

export interface OpenCursorSdkStoreOptions {
  root: string;
  /** The JSONL store a failed migration keeps serving. */
  openLegacy: () => LocalAgentStore;
  onMigrationError: (error: unknown) => void;
  openSqlite?: (stateRoot: string) => Promise<SqliteCursorStore>;
}

interface OpenStore {
  store: LocalAgentStore;
  dispose?: () => Promise<void>;
}

const stores = new Map<string, Promise<OpenStore>>();

async function openSdkSqlite(stateRoot: string): Promise<SqliteCursorStore> {
  const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
  return SqliteLocalAgentStore.open({ workspaceRef: WORKSPACE_REF, stateRoot });
}

/** Open the shared store for a `cursor-sdk` directory, migrating its JSONL tables first. */
export async function openCursorSdkStore(
  options: OpenCursorSdkStoreOptions,
): Promise<LocalAgentStore> {
  let opened = stores.get(options.root);
  if (!opened) {
    opened = prepareStore(options);
    stores.set(options.root, opened);
    opened.catch(() => stores.delete(options.root));
  }
  return (await opened).store;
}

/** Close every store this process opened, so SQLite checkpoints its write-ahead log. */
export async function closeCursorSdkStores(): Promise<void> {
  const opened = [...stores.values()];
  stores.clear();
  await Promise.all(opened.map(async (store) => (await store.catch(() => undefined))?.dispose?.()));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function prepareStore(options: OpenCursorSdkStoreOptions): Promise<OpenStore> {
  const { root, openSqlite = openSdkSqlite } = options;
  const target = join(root, SQLITE_DIRECTORY);
  if (!(await exists(join(target, MARKER)))) {
    const failures = await readFailures(root);
    if (failures >= MAX_MIGRATION_ATTEMPTS) {
      options.onMigrationError(
        new Error(
          `Cursor SDK store migration failed ${failures} times; serving the JSONL store. Delete ${join(root, FAILURES_FILE)} to retry.`,
        ),
      );
      return { store: options.openLegacy() };
    }
    try {
      await migrateCursorSdkStore(root, openSqlite);
      await rm(join(root, FAILURES_FILE), { force: true });
    } catch (error) {
      await writeFile(join(root, FAILURES_FILE), `${failures + 1}\n`).catch(() => undefined);
      options.onMigrationError(error);
      return { store: options.openLegacy() };
    }
  }
  const sqlite = await openSqlite(target);
  return { store: guardStore(sqlite), dispose: () => sqlite.dispose() };
}

async function readFailures(root: string): Promise<number> {
  const text = await readFile(join(root, FAILURES_FILE), "utf8").catch(() => "0");
  return Number.parseInt(text, 10) || 0;
}

/**
 * Build the SQLite store in a staging directory, verify every row against the
 * JSONL tables, and swap it in atomically. A crash mid-migration leaves the
 * JSONL tables in charge and the next open starts over.
 */
export async function migrateCursorSdkStore(
  root: string,
  openSqlite: (stateRoot: string) => Promise<SqliteCursorStore> = openSdkSqlite,
): Promise<CursorStoreMigration> {
  const release = await lock(join(root, LOCK_FILE));
  try {
    const staging = join(root, STAGING_DIRECTORY);
    const target = join(root, SQLITE_DIRECTORY);
    const before = await legacyStamp(root);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const store = await openSqlite(staging);
    let counts: CursorStoreMigration["counts"];
    try {
      counts = await copyLegacyTables(root, store);
      await verifyLegacyTables(root, store);
    } finally {
      await store.dispose();
    }
    // Another process writing the JSONL tables meanwhile would lose its rows.
    if (!isDeepStrictEqual(before, await legacyStamp(root))) {
      throw new Error("Cursor SDK JSONL tables changed during migration");
    }
    const migration: CursorStoreMigration = {
      fresh: Object.values(before).every((entry) => entry === null),
      migratedAt: new Date().toISOString(),
      counts,
    };
    await writeFile(join(staging, MARKER), `${JSON.stringify(migration)}\n`, { mode: 0o600 });
    await syncPath(join(staging, MARKER));
    // A target without a marker is a swap that never finished; the staging copy replaces it.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await syncPath(dirname(target));
    return migration;
  } finally {
    await release();
  }
}

async function legacyStamp(root: string) {
  const entries = await Promise.all(
    Object.values(LEGACY_TABLES).map(async (name) => {
      const info = await stat(join(root, name)).catch(() => null);
      return [name, info && { size: info.size, mtimeMs: info.mtimeMs }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function lock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      if (holder > 0 && processExists(holder)) {
        throw new Error(`Cursor SDK store migration is running in process ${holder}`, {
          cause: error,
        });
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Cursor SDK store migration could not take its lock");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LegacyEvent {
  runId: string;
  seq: number;
  eventType: string;
  payload?: unknown;
  payloadRef?: string | null;
  idempotencyKey?: string | null;
}

interface LegacyBlob {
  agentId: string;
  blobId: string;
  dataBase64: string;
}

async function copyLegacyTables(
  root: string,
  store: SqliteCursorStore,
): Promise<CursorStoreMigration["counts"]> {
  const counts = { agents: 0, runs: 0, runEvents: 0, checkpoints: 0 };
  for await (const agent of readTable<LocalAgentDocument>(root, "agents")) {
    await store.agents.create({ agent });
    counts.agents++;
  }
  for await (const run of readTable<LocalAgentRunDocument>(root, "runs")) {
    await store.runs.create({ run });
    counts.runs++;
  }
  for await (const event of readTable<LegacyEvent>(root, "runEvents")) {
    const copy = await store.runEvents.append({
      runId: event.runId,
      eventType: event.eventType,
      payload: event.payload,
      payloadRef: event.payloadRef ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
    });
    // History derives message IDs from seq, so a renumbered event changes them.
    // A repeated idempotency key also lands here: the SDK returns the earlier row.
    if (copy.seq !== event.seq) {
      throw new Error(
        `Cursor SDK store migration renumbered ${event.runId} event ${event.seq} as ${copy.seq}`,
      );
    }
    counts.runEvents++;
  }
  for await (const blob of readTable<LegacyBlob>(root, "checkpoints")) {
    await store.checkpoints.create({
      agentId: blob.agentId,
      blobId: blob.blobId,
      data: Buffer.from(blob.dataBase64, "base64"),
    });
    await assertBlobsPersist(store, blob.agentId);
    counts.checkpoints++;
  }
  return counts;
}

/** Read every migrated row back and compare it with the JSONL row it came from. */
async function verifyLegacyTables(root: string, store: LocalAgentStore): Promise<void> {
  function mismatch(what: string): never {
    throw new Error(`Cursor SDK store migration changed ${what}`);
  }
  for await (const agent of readTable<LocalAgentDocument>(root, "agents")) {
    const copy = await store.agents.get({ agentId: agent.agentId });
    if (!copy || !isDeepStrictEqual(agentFields(copy), agentFields(agent))) {
      mismatch(`agent ${agent.agentId}`);
    }
  }
  for await (const run of readTable<LocalAgentRunDocument>(root, "runs")) {
    const copy = await store.runs.get({ agentId: run.agentId, runId: run.runId });
    if (!copy || !isDeepStrictEqual(runFields(withEndTime(copy)), runFields(run))) {
      mismatch(`run ${run.runId}`);
    }
  }
  for await (const event of readTable<LegacyEvent>(root, "runEvents")) {
    const page = await store.runEvents.list({
      runId: event.runId,
      afterOffset: String(event.seq - 1),
      limit: 1,
    });
    const copy = page.items[0];
    if (
      !copy ||
      copy.seq !== event.seq ||
      copy.eventType !== event.eventType ||
      !isDeepStrictEqual(copy.payload, event.payload ?? null) ||
      copy.payloadRef !== (event.payloadRef ?? null) ||
      copy.idempotencyKey !== (event.idempotencyKey ?? null)
    ) {
      mismatch(`${event.runId} event ${event.seq}`);
    }
  }
  for await (const blob of readTable<LegacyBlob>(root, "checkpoints")) {
    const copy = await store.checkpoints.get({ agentId: blob.agentId, blobId: blob.blobId });
    if (!copy || !Buffer.from(blob.dataBase64, "base64").equals(copy)) {
      mismatch(`checkpoint ${blob.blobId} of ${blob.agentId}`);
    }
  }
}

function agentFields(agent: LocalAgentDocument) {
  const { agentId, cwd, status, activeRunId, latestCheckpoint, name, createdAt, updatedAt } = agent;
  return {
    // Holds the chat's blob encryption key; losing it makes the history unreadable.
    sdkMetadata: agent.sdkMetadata ?? {},
    agentId,
    cwd,
    status,
    activeRunId: activeRunId ?? null,
    latestCheckpoint: latestCheckpoint ?? null,
    name: name ?? null,
    createdAt,
    updatedAt,
  };
}

function runFields(run: LocalAgentRunDocument) {
  return {
    runId: run.runId,
    requestId: run.requestId ?? null,
    agentId: run.agentId,
    turnNumber: run.turnNumber,
    status: run.status,
    model: run.model ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
    usageRef: run.usageRef ?? null,
    usage: run.usage ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    startCheckpointRef: run.startCheckpointRef ?? null,
    latestCheckpointRef: run.latestCheckpointRef ?? null,
  };
}

/** Stream one JSONL table a line at a time; the old store held whole tables in memory. */
async function* readTable<T>(root: string, table: keyof typeof LEGACY_TABLES): AsyncGenerator<T> {
  const path = join(root, LEGACY_TABLES[table]);
  if (!(await exists(path))) return;
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let number = 0;
  for await (const line of lines) {
    number++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Cursor SDK store migration could not parse ${path}:${number}`, {
        cause: error,
      });
    }
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The SQLite store records an end time only for finished, cancelled and expired
 * runs. Report an errored run's last update as its end, as the JSONL store did,
 * so usage and history don't treat it as still running.
 */
function withEndTime(run: LocalAgentRunDocument): LocalAgentRunDocument {
  return run.status === "error" && run.endedAt == null ? { ...run, endedAt: run.updatedAt } : run;
}

interface BlobStoreInternals {
  deps?: {
    checkpointStore?: {
      getBlobStore?: (agentId: string) => Promise<{ degradationWarning?: string }>;
    };
  };
}

/**
 * When SQLite can't open a chat's checkpoint database, SDK 1.4.2 keeps that
 * chat's blobs in memory and only prints a warning, so a restart would lose
 * them. It exposes the state only on a private field; read it after every
 * checkpoint write and fail the write instead.
 */
async function assertBlobsPersist(store: SqliteCursorStore, agentId: string): Promise<void> {
  const getBlobStore = (store as BlobStoreInternals).deps?.checkpointStore?.getBlobStore;
  if (typeof getBlobStore !== "function") {
    throw new Error("Cursor SDK store no longer exposes its checkpoint persistence state");
  }
  const blobs = await getBlobStore.call(
    (store as BlobStoreInternals).deps!.checkpointStore,
    agentId,
  );
  if (blobs.degradationWarning !== undefined) {
    throw new Error(
      `Cursor SDK could not persist checkpoints for ${agentId}: ${blobs.degradationWarning}`,
    );
  }
}

function guardStore(store: SqliteCursorStore): LocalAgentStore {
  const { runs, checkpoints } = store;
  return {
    agents: store.agents,
    runEvents: store.runEvents,
    checkpoints: {
      get: (input) => checkpoints.get(input),
      list: (input) => checkpoints.list(input),
      delete: (input) => checkpoints.delete(input),
      create: async (input) => {
        await checkpoints.create(input);
        await assertBlobsPersist(store, input.agentId);
      },
      update: async (input) => {
        await checkpoints.update(input);
        await assertBlobsPersist(store, input.agentId);
      },
    },
    runs: {
      get: async (input) => {
        const run = await runs.get(input);
        return run && withEndTime(run);
      },
      create: async (input) => withEndTime(await runs.create(input)),
      update: async (input) => withEndTime(await runs.update(input)),
      delete: (input) => runs.delete(input),
      list: async (input) => {
        const page = await runs.list(input);
        return { ...page, items: page.items.map(withEndTime) };
      },
    },
  };
}
