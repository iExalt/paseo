import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  LocalAgentCheckpointRef,
  LocalAgentDocument,
  LocalAgentRunDocument,
  LocalAgentStore,
} from "@cursor/sdk";
import { readCursorHistory, type HistorySdk } from "./cursor-sdk-history.js";
import type { CursorTurnJournal, CursorHistoryTurn } from "./cursor-sdk-turn-journal.js";

const TERMINAL_RUN = new Set(["finished", "error", "cancelled", "expired"]);

export class CursorRewindError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CursorRewindError";
  }
}

export interface CursorFork {
  agentId: string;
  journal: CursorTurnJournal;
  /** Deletes the fork before anything has used it. */
  discard: () => Promise<void>;
}

interface CursorRewindTarget {
  run: LocalAgentRunDocument;
  record?: CursorHistoryTurn;
}

function runIdsOf(record: CursorHistoryTurn): string[] {
  return [
    ...new Set(
      [record.nativeRunId, ...(record.executionRunIds ?? []), ...(record.followUpIds ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
}

async function readRuns(store: LocalAgentStore, agentId: string) {
  const runs: LocalAgentRunDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({ filter: { agentIds: [agentId], cursor } });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return runs.sort((a, b) => a.turnNumber - b.turnNumber);
}

/** Finds the turn a message started, using the same projection the chat shows. */
async function resolveTarget(params: {
  sdk: HistorySdk;
  store: LocalAgentStore;
  journal: CursorTurnJournal;
  agentId: string;
  messageId: string;
  runs: LocalAgentRunDocument[];
  records: CursorHistoryTurn[];
}): Promise<CursorRewindTarget> {
  const { messageId, runs, records } = params;
  const prompted = new Set<string>();
  let found: { turnId: string; first: boolean } | undefined;
  for await (const event of readCursorHistory(
    params.sdk,
    params.store,
    params.journal,
    params.agentId,
  )) {
    if (event.type !== "timeline" || event.item.type !== "user_message" || !event.turnId) continue;
    const first = !prompted.has(event.turnId);
    prompted.add(event.turnId);
    const { item } = event;
    if (item.messageId === messageId || item.clientMessageId === messageId) {
      found = { turnId: event.turnId, first };
      break;
    }
  }
  if (!found) {
    throw new CursorRewindError("Cursor SDK could not find this message in the saved chat.");
  }
  if (!found.first) {
    throw new CursorRewindError(
      "Cursor SDK can rewind only to a message that started a turn, not to a follow-up sent during one.",
    );
  }
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const record = records.find((turn) => turn.id === found.turnId);
  // A turn's first native run carries the conversation as it stood before the prompt.
  const owned = record ? runIdsOf(record).map((id) => byId.get(id)) : [byId.get(found.turnId)];
  // A recorded run with no row would make an earlier run look like the turn's start.
  const run = owned.includes(undefined)
    ? undefined
    : owned.sort((a, b) => a!.turnNumber - b!.turnNumber)[0];
  if (!run) {
    throw new CursorRewindError(
      "Cursor SDK has no saved checkpoint for this message, so the chat was left unchanged.",
    );
  }
  return { run, record };
}

interface CursorForkPlan {
  source: LocalAgentDocument;
  checkpoint: LocalAgentCheckpointRef | null;
  kept: LocalAgentRunDocument[];
  keptRecords: CursorHistoryTurn[];
}

function keepRecord(
  record: CursorHistoryTurn,
  target: CursorRewindTarget,
  kept: Set<string>,
  cutoff: string,
): boolean {
  if (record === target.record) return false;
  const ids = runIdsOf(record);
  if (!ids.length) return record.createdAt < cutoff;
  const before = ids.filter((id) => kept.has(id)).length;
  if (before === 0) return false;
  if (before < ids.length) {
    throw new CursorRewindError(
      "A Cursor SDK turn overlaps this message, so the chat was left unchanged.",
    );
  }
  if (!record.joined || record.ownerStopPending) {
    throw new CursorRewindError(
      "An earlier Cursor SDK turn has not finished shutting down, so the chat was left unchanged.",
    );
  }
  return true;
}

async function planCursorFork(params: ForkCursorConversationParams): Promise<CursorForkPlan> {
  const { store, journal, agentId } = params;
  const source = await store.agents.get({ agentId });
  if (!source) throw new CursorRewindError("Cursor SDK could not find the saved local agent.");
  if (source.status === "running") {
    throw new CursorRewindError("Stop the running Cursor SDK turn before rewinding.");
  }
  const runs = await readRuns(store, agentId);
  const records = await journal.read();
  const target = await resolveTarget({ ...params, runs, records });
  const kept = runs.filter((run) => run.turnNumber < target.run.turnNumber);
  const checkpoint = target.run.startCheckpointRef ?? null;
  // Only a chat with no earlier saved conversation rewinds to an empty one. Turn
  // numbers alone don't show that: resume cancels the SDK's reserved first run.
  if (!checkpoint && kept.some((run) => run.latestCheckpointRef)) {
    throw new CursorRewindError(
      "Cursor SDK did not record a checkpoint before this message, so the chat was left unchanged.",
    );
  }
  if (checkpoint && !(await store.checkpoints.get({ agentId, blobId: checkpoint.rootBlobId }))) {
    throw new CursorRewindError(
      "Cursor SDK's checkpoint for this message is no longer stored, so the chat was left unchanged.",
    );
  }
  const active = kept.find((run) => !TERMINAL_RUN.has(run.status));
  if (active) {
    throw new CursorRewindError(
      `Cursor SDK run ${active.runId} has not finished, so the chat was left unchanged.`,
    );
  }
  const keptIds = new Set(kept.map((run) => run.runId));
  const cutoff = target.record?.createdAt ?? new Date(target.run.createdAt).toISOString();
  const keptRecords = records.filter((record) => keepRecord(record, target, keptIds, cutoff));
  return { source, checkpoint, kept, keptRecords };
}

async function copyCheckpoints(store: LocalAgentStore, from: string, to: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.checkpoints.list({ filter: { agentIds: [from], cursor } });
    for (const blobId of page.items) {
      const data = await store.checkpoints.get({ agentId: from, blobId });
      if (data) await store.checkpoints.create({ agentId: to, blobId, data });
    }
    cursor = page.nextCursor;
  } while (cursor);
}

async function copyRun(
  store: LocalAgentStore,
  run: LocalAgentRunDocument,
  agentId: string,
  runId: string,
): Promise<void> {
  await store.runs.create({ run: { ...run, agentId, runId } });
  const events = await store.runEvents.list({ runId: run.runId, limit: Number.MAX_SAFE_INTEGER });
  for (const event of events.items) {
    await store.runEvents.append({
      runId,
      eventType: event.eventType,
      payload: event.payload,
      payloadRef: event.payloadRef,
      idempotencyKey: event.idempotencyKey,
    });
  }
}

interface ForkCursorConversationParams {
  sdk: HistorySdk;
  store: LocalAgentStore;
  journal: CursorTurnJournal;
  agentId: string;
  messageId: string;
  newAgentId?: string;
}

/**
 * Copies the conversation before `messageId` into a new local SDK agent. The
 * source agent, its runs, checkpoints and journal stay unchanged.
 */
export async function forkCursorConversation(
  params: ForkCursorConversationParams,
): Promise<CursorFork> {
  const { store, journal, agentId } = params;
  const { source, checkpoint, kept, keptRecords } = await planCursorFork(params);
  const runIds = new Map(kept.map((run) => [run.runId, `run-${randomUUID()}`]));
  const remap = (id: string) => runIds.get(id) ?? id;
  const forkId = params.newAgentId ?? `agent-${randomUUID()}`;
  const forkJournal = journal.forAgent(forkId);
  const discard = async () => {
    await store.agents.delete({ filter: { agentIds: [forkId] } });
    await discardCursorFork(store, forkJournal, forkId, [...runIds.values()]);
  };
  try {
    await copyCheckpoints(store, agentId, forkId);
    for (const run of kept) await copyRun(store, run, forkId, remap(run.runId));
    for (const record of keptRecords) {
      await forkJournal.copyTurnFrom(journal, record, {
        ...record,
        nativeRunId: record.nativeRunId && remap(record.nativeRunId),
        executionRunIds: record.executionRunIds?.map(remap),
        followUpIds: record.followUpIds?.map(remap),
      });
    }
    const now = Date.now();
    // The agent row commits the fork: listing and resume see it only once complete.
    await store.agents.create({
      agent: {
        ...source,
        agentId: forkId,
        status: "idle",
        activeRunId: null,
        latestCheckpoint: checkpoint,
        createdAt: now,
        updatedAt: now,
      },
    });
    // The SDK decrypts the checkpoint chain here; a broken chain fails before the chat moves.
    await params.sdk.Agent.messages.list(forkId, { runtime: "local", cwd: source.cwd, store });
  } catch (error) {
    await discard().catch(() => {});
    if (error instanceof CursorRewindError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CursorRewindError(
      `Cursor SDK could not recover the conversation before this message, so the chat was left unchanged. ${detail}`,
      { cause: error },
    );
  }
  return { agentId: forkId, journal: forkJournal, discard };
}

async function discardCursorFork(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  forkId: string,
  runIds: string[],
): Promise<void> {
  // An empty run filter matches every row in the store.
  if (runIds.length) {
    await store.runEvents.delete({ filter: { runIds } });
    await store.runs.delete({ filter: { runIds } });
  }
  await store.checkpoints.delete({ filter: { agentIds: [forkId] } });
  await rm(journal.path, { recursive: true, force: true });
}
