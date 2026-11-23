import type {
  LocalAgentRunDocument,
  LocalAgentStore,
  RunResult,
  SDKMessage,
  TokenUsage,
} from "@cursor/sdk";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPersistenceHandle,
  AgentSession,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import { resolveCursorContextWindowMaxTokens } from "./cursor-sdk-model.js";
import { CURSOR_SDK_PROVIDER as PROVIDER } from "./cursor-sdk-auth.js";
import {
  addCursorUsage,
  cursorTimelineItems,
  mapCursorTool,
  mapCursorUsage,
  replayCursorTool,
} from "./cursor-sdk-telemetry.js";
import { isProviderImageMessage } from "./provider-image-output.js";
import type {
  CursorHistoryTurn,
  CursorHistoryUser,
  CursorTurnJournal,
} from "./cursor-sdk-turn-journal.js";

type CursorSdk = typeof import("@cursor/sdk");
export type HistorySdk = Pick<
  CursorSdk,
  "LOCAL_RUN_STREAM_EVENT_TYPE" | "decodeLocalRunStreamEvent" | "localRunStreamEventToSdkMessage"
> & { Agent: Pick<CursorSdk["Agent"], "messages"> };

const checkpointPromptSchema = z.object({
  turn: z.object({
    case: z.literal("agentConversationTurn"),
    value: z.object({
      userMessage: z.object({
        text: z.string(),
        messageId: z.string().optional(),
        startedAtMs: z.bigint(),
      }),
    }),
  }),
});

// Image output is shown as assistant markdown but is not the assistant's answer.
function isAnswerText(item: AgentTimelineItem): boolean {
  return item.type === "assistant_message" && !isProviderImageMessage(item.text);
}

function cursorUserMessageId(runId: string): string {
  return `${runId}:user`;
}

export function streamItems(
  message: SDKMessage,
  tools: Map<string, ToolCallTimelineItem>,
  summaryTrigger?: "manual" | "auto",
): AgentTimelineItem[] {
  switch (message.type) {
    case "assistant":
      return message.message.content.flatMap((block) =>
        block.type === "text" && block.text
          ? [{ type: "assistant_message" as const, text: block.text }]
          : [],
      );
    case "thinking":
      return message.text ? [{ type: "reasoning", text: message.text }] : [];
    case "summary":
      // The compaction card has no failed/canceled state. Use the run status for
      // progress so an interrupted summary cannot leave a stale loading card.
      if (message.status === "running") return [];
      if (message.status === "error") {
        return [
          {
            type: "notification",
            level: "warning",
            message: "Cursor SDK could not summarize this conversation.",
          },
        ];
      }
      return [
        {
          type: "compaction",
          status: "completed",
          ...(summaryTrigger ? { trigger: summaryTrigger } : {}),
        },
        ...(message.fallback
          ? [
              {
                type: "notification" as const,
                level: "warning" as const,
                message:
                  "Cursor SDK saved a trimmed transcript after it could not generate a summary.",
              },
            ]
          : []),
      ];
    case "tool_call": {
      const key = `${message.run_id}:${message.call_id}`;
      const previous = tools.get(key);
      if (previous && previous.status !== "running" && message.status === "running") return [];
      const item = mapCursorTool(message, previous);
      if (isDeepStrictEqual(previous, item)) return [];
      tools.set(key, item);
      return cursorTimelineItems(item);
    }
    default:
      return [];
  }
}

export function terminalTools(
  tools: Map<string, ToolCallTimelineItem>,
  status: RunResult["status"],
): ToolCallTimelineItem[] {
  return Array.from(tools.values()).flatMap((item): ToolCallTimelineItem[] => {
    if (item.status !== "running") {
      return [];
    }
    return [
      status === "cancelled"
        ? { ...item, status: "canceled" }
        : { ...item, status: "failed", error: "Cursor did not return a tool result." },
    ];
  });
}

function writeHistoryItem(
  items: AgentTimelineItem[],
  positions: Map<string, number>,
  item: AgentTimelineItem,
): void {
  if (item.type === "tool_call") {
    const position = positions.get(item.callId) ?? items.length;
    positions.set(item.callId, position);
    items[position] = item;
    return;
  }
  const previous = items.at(-1);
  if (
    (item.type === "assistant_message" || item.type === "reasoning") &&
    previous?.type === item.type
  ) {
    previous.text += item.text;
    return;
  }
  items.push(item);
}

export function interruptedCursorRunMessage(runId: string): string {
  return `Cursor SDK run ${runId} has no confirmed shutdown and its tools could still be running. This chat can resume once Paseo confirms that the previous tools have exited on the original host. The saved history is still available.`;
}

export function cursorUnresolvedSteerMessage(): string {
  return "Cursor SDK queued a follow-up but did not identify its run. Check the original Cursor SDK session before resending.";
}

export async function* readCursorHistory(
  sdk: HistorySdk,
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  id: string,
): AsyncGenerator<AgentStreamEvent> {
  const native = await store.agents.get({ agentId: id });
  if (!native) {
    throw new Error("Cursor SDK could not find the saved local agent.");
  }

  const runs = await readCursorRuns(store, id);
  runs.sort((a, b) => a.turnNumber - b.turnNumber);
  const records = await journal.read();
  const knownIds = new Set(runs.map((run) => run.runId));
  const byRun = new Map(
    records.filter((record) => record.nativeRunId).map((record) => [record.nativeRunId, record]),
  );
  const ownedFollowUpIds = new Set(
    records.flatMap((record) => [
      ...(record.followUpIds ?? []),
      ...(record.executionRunIds ?? []).filter((runId) => runId !== record.nativeRunId),
    ]),
  );
  const replay = [
    ...runs.flatMap((run) => {
      if (ownedFollowUpIds.has(run.runId)) return [];
      const record = byRun.get(run.runId);
      if (
        !record &&
        run.startedAt == null &&
        (run.status === "queued" || run.status === "cancelled")
      )
        return [];
      return [{ run, record, time: record?.createdAt ?? new Date(run.createdAt).toISOString() }];
    }),
    ...records
      .filter((record) => !record.nativeRunId || !knownIds.has(record.nativeRunId))
      .map((record) => ({ run: undefined, record, time: record.createdAt })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  const unmatchedRuns = runs.filter(
    (run) => !byRun.has(run.runId) && !ownedFollowUpIds.has(run.runId) && run.endedAt != null,
  );
  const prompts = await legacyCheckpointPrompts(sdk, store, id, native.cwd, unmatchedRuns);
  for (const { run, record, time } of replay) {
    const turnId = record?.id ?? run?.runId;
    if (!turnId) continue;
    let projection: TurnProjection;
    if (record) projection = await readJournalTurn(sdk, store, journal, record, run);
    else if (run) projection = await readLegacyTurn(sdk, store, run, prompts.get(run.runId));
    else continue;
    const { items, errorCard } = projection;
    for (const item of items) {
      yield { type: "timeline", provider: PROVIDER, turnId, timestamp: time, item };
    }
    if (errorCard) {
      yield { type: "timeline", provider: PROVIDER, timestamp: time, item: errorCard };
    }
  }
}

interface TurnProjection {
  items: AgentTimelineItem[];
  errorCard?: AgentTimelineItem;
}

function renderErrorCard(message: string, code?: string): AgentTimelineItem {
  const detail = code ? `\n\ncode: ${code}` : "";
  return {
    type: "assistant_message",
    text: `[System Error] ${message.trim() || "Provider run failed"}${detail}`,
  };
}

function turnRecoveryNote(record: CursorHistoryTurn): string {
  if (record.unresolvedNativeFollowUp) return cursorUnresolvedSteerMessage();
  const runId = record.followUpIds?.at(-1) ?? record.nativeRunId;
  if (runId) return interruptedCursorRunMessage(runId);
  return "Cursor SDK admission was interrupted before delivery could be confirmed.";
}

async function readJournalItems(
  sdk: HistorySdk,
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  record: CursorHistoryTurn,
  run?: LocalAgentRunDocument,
): Promise<JournalItems> {
  // Replay can expand or drop a journaled row, but steers count journaled rows.
  const starts: number[] = [];
  const events: AgentTimelineItem[] = [];
  for (const item of await journal.readItems(record.id)) {
    starts.push(events.length);
    events.push(...(item.type === "tool_call" ? replayCursorTool(item) : [item]));
  }
  const steerAt = (after: number) => starts[after] ?? events.length;
  if (!run || (!record.recovered && (events.length > 0 || record.terminal))) {
    return { events, steerAt, incomplete: false };
  }
  const native: AgentTimelineItem[] = [];
  for (const runId of record.executionRunIds ?? [run.runId]) {
    for (const event of await readNativeItems(sdk, store, runId, {
      includeUser: false,
      summaryTrigger: record.compact ? "manual" : "auto",
    }))
      native.push(event);
  }
  // summarize() returns its text in wait(), outside the native summary event stream.
  const last = events.at(-1);
  if (
    record.compact &&
    run.status === "finished" &&
    last?.type === "assistant_message" &&
    last.text === run.result &&
    !native.some((item) => item.type === "assistant_message")
  ) {
    native.push(last);
  }
  if (events.length === 0) {
    return {
      events: native,
      steerAt: (after) => after,
      incomplete: isPartialAnswer(record, native),
    };
  }
  return {
    events,
    steerAt,
    incomplete:
      isPartialAnswer(record, events) ||
      (native.length > 0 &&
        !isDeepStrictEqual(recoveryComparable(events), recoveryComparable(native))),
  };
}

interface JournalItems {
  events: AgentTimelineItem[];
  /** Where a steer recorded after `after` journaled rows belongs among the events. */
  steerAt: (after: number) => number;
  incomplete: boolean;
}

interface ComparableTool {
  type: "tool_call";
  callId: string;
  name: string;
  status: ToolCallTimelineItem["status"];
}

// A gap shows as a missing row or status. Tool content is not compared: the
// journal truncates large rows, older journals stored another projection, and
// repeated partial updates should not imply a transcript gap.
function recoveryComparable(events: AgentTimelineItem[]): unknown[] {
  const tools = new Map<string, ComparableTool>();
  return events.flatMap<unknown>((item) => {
    // Live MCP images have no native counterpart; generated images exist on both sides.
    if (item.type === "assistant_message" && !isAnswerText(item)) return [];
    // The journal holds the limited copy of each item.
    if (item.type !== "tool_call") return [limitAgentTimelineItemContent(item)];
    const { callId, name, status } = item;
    const previous = tools.get(callId);
    if (previous && previous.status !== "running" && status === "running") return [];
    if (previous?.status === status && previous.name === name) return [];
    const comparable: ComparableTool = { type: "tool_call", callId, name, status };
    tools.set(callId, comparable);
    return [comparable];
  });
}

function isPartialAnswer(record: CursorHistoryTurn, events: AgentTimelineItem[]): boolean {
  if (!record.recovered || record.terminal?.status !== "finished" || !record.terminal.fallback)
    return false;
  const assistant = events
    .flatMap((event) =>
      event.type === "assistant_message" && isAnswerText(event) ? [event.text] : [],
    )
    .join("");
  return Boolean(assistant && assistant !== record.terminal.fallback);
}

async function readJournalTurn(
  sdk: HistorySdk,
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  record: CursorHistoryTurn,
  run?: LocalAgentRunDocument,
): Promise<TurnProjection> {
  const { events, steerAt, incomplete } = await readJournalItems(sdk, store, journal, record, run);
  const items: AgentTimelineItem[] = [record.user];
  let steerIndex = 0;
  for (const [index, event] of events.entries()) {
    while (steerIndex < record.steers.length && steerAt(record.steers[steerIndex].after) <= index) {
      items.push(record.steers[steerIndex++].user);
    }
    items.push(event);
  }
  for (const steer of record.steers.slice(steerIndex)) items.push(steer.user);
  // A partial journal cannot be aligned to a native suffix when Cursor omitted
  // an event or the output repeated. Keep that prefix and label the gap.
  if (!record.joined && !record.recovered && (!record.terminal || record.nativeRunId)) {
    items.push({ type: "error", message: turnRecoveryNote(record) });
  } else if (record.recovered && record.unresolvedNativeFollowUp) {
    items.push({ type: "error", message: cursorUnresolvedSteerMessage() });
  }
  if (incomplete) {
    items.push({
      type: "error",
      message: "Some saved Cursor SDK output could not be matched to this turn's timeline.",
    });
  }
  if (record.terminal?.status === "error") {
    return { items, errorCard: renderErrorCard(record.terminal.message, record.terminal.code) };
  }
  if (
    record.terminal?.status === "finished" &&
    record.terminal.fallback &&
    !items.some(isAnswerText)
  ) {
    items.push({ type: "assistant_message", text: record.terminal.fallback });
  }
  return { items };
}

async function readLegacyTurn(
  sdk: HistorySdk,
  store: LocalAgentStore,
  run: LocalAgentRunDocument,
  prompt?: CursorHistoryUser,
): Promise<TurnProjection> {
  const items: AgentTimelineItem[] = prompt ? [prompt] : [];
  const positions = new Map<string, number>();
  const tools = new Map<string, ToolCallTimelineItem>();
  const events = await readNativeItems(sdk, store, run.runId, { includeUser: !prompt });
  for (const item of events) {
    writeHistoryItem(items, positions, item);
    if (item.type === "tool_call") tools.set(item.callId, item);
  }
  if (run.status === "queued" || run.status === "running") {
    items.push({ type: "error", message: interruptedCursorRunMessage(run.runId) });
    return { items };
  }
  for (const item of terminalTools(tools, run.status === "expired" ? "error" : run.status)) {
    writeHistoryItem(items, positions, item);
  }
  if (run.status === "finished" && run.result && !items.some(isAnswerText)) {
    items.push({ type: "assistant_message", text: run.result });
  }
  if (run.status === "error") {
    return { items, errorCard: renderErrorCard(run.error ?? "Cursor SDK run failed.") };
  }
  if (run.status === "expired") {
    items.push({ type: "error", message: `Cursor SDK run ${run.runId} expired.` });
  }
  return { items };
}

async function readNativeItems(
  sdk: HistorySdk,
  store: LocalAgentStore,
  runId: string,
  options: { includeUser: boolean; summaryTrigger?: "auto" | "manual" },
): Promise<AgentTimelineItem[]> {
  // JsonlLocalAgentStore returns one finite snapshot even when a writer is live.
  const page = await store.runEvents.list({ runId, limit: Number.MAX_SAFE_INTEGER });
  const items: AgentTimelineItem[] = [];
  const tools = new Map<string, ToolCallTimelineItem>();
  let userCount = 0;
  for (const event of page.items) {
    if (event.eventType !== sdk.LOCAL_RUN_STREAM_EVENT_TYPE) continue;
    const decoded = sdk.decodeLocalRunStreamEvent(event.payload);
    const message = sdk.localRunStreamEventToSdkMessage(decoded);
    if (!message) continue;
    if (message.type === "user" && options.includeUser) {
      const text = message.message.content.map((block) => block.text).join("");
      if (text) {
        const messageId =
          userCount++ === 0 ? cursorUserMessageId(runId) : `${runId}:user:${event.seq}`;
        items.push({ type: "user_message", text, messageId });
      }
    }
    items.push(...streamItems(message, tools, options.summaryTrigger));
  }
  return items;
}

async function legacyCheckpointPrompts(
  sdk: HistorySdk,
  store: LocalAgentStore,
  id: string,
  cwd: string,
  runs: LocalAgentRunDocument[],
): Promise<Map<string, CursorHistoryUser>> {
  const byRun = new Map<string, CursorHistoryUser>();
  if (!runs.length) return byRun;
  const messages = await sdk.Agent.messages.list(id, { runtime: "local", cwd, store });
  const prompts = messages
    .flatMap(({ message }) => {
      const parsed = checkpointPromptSchema.safeParse(message);
      if (!parsed.success) return [];
      const { text, messageId, startedAtMs } = parsed.data.turn.value.userMessage;
      const time = Number(startedAtMs);
      return Number.isSafeInteger(time) && time > 0 ? [{ text, messageId, time }] : [];
    })
    .sort((a, b) => a.time - b.time);
  let next = 0;
  for (const run of runs) {
    if (run.endedAt == null) continue;
    const start = run.startedAt ?? run.createdAt;
    while (next < prompts.length && prompts[next].time < start) next++;
    const first = next;
    while (next < prompts.length && prompts[next].time <= run.endedAt) next++;
    if (next === first + 1) {
      const { text, messageId } = prompts[first];
      byRun.set(run.runId, {
        type: "user_message",
        text,
        messageId: messageId?.trim() || cursorUserMessageId(run.runId),
      });
    }
  }
  return byRun;
}

export function openCursorHistorySession(params: {
  sdk: HistorySdk;
  store: LocalAgentStore;
  journal: CursorTurnJournal;
  handle: AgentPersistenceHandle;
  id: string;
  model: string;
  providerOptions?: ProviderOptions;
  mode: string;
  modes: AgentMode[];
  capabilities: AgentCapabilityFlags;
}): AgentSession {
  const { sdk, store, journal, handle, id, model, providerOptions, mode, modes, capabilities } =
    params;
  const requiresInteractive = async (): Promise<never> => {
    throw new Error(
      "Open this Cursor SDK session interactively before starting or changing a turn.",
    );
  };
  return {
    id,
    provider: PROVIDER,
    capabilities,
    subscribe: () => () => {},
    streamHistory: () => readCursorHistory(sdk, store, journal, id),
    readLastUsage: async () => {
      const usage = await readCursorLastUsage(store, journal, id);
      if (!usage) return undefined;
      const { contextWindowMaxTokens: _storedMax, ...rest } = usage;
      const contextWindowMaxTokens = resolveCursorContextWindowMaxTokens(
        { id: model },
        providerOptions,
      );
      return {
        ...rest,
        ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
      };
    },
    getRuntimeInfo: async () => ({ provider: PROVIDER, sessionId: id, model, modeId: mode }),
    getAvailableModes: async () => modes,
    getCurrentMode: async () => mode,
    listCommands: async () => [],
    getPendingPermissions: () => [],
    run: requiresInteractive,
    startTurn: requiresInteractive,
    setMode: requiresInteractive,
    setModel: requiresInteractive,
    respondToPermission: requiresInteractive,
    describePersistence: () => handle,
    interrupt: async () => {},
    close: async () => {},
  };
}

export async function readCursorRuns(
  store: LocalAgentStore,
  id: string,
): Promise<LocalAgentRunDocument[]> {
  const runs: LocalAgentRunDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({ filter: { agentIds: [id], cursor } });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return runs;
}

export async function readCursorUsageHistory(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  id: string,
) {
  const [runs, records] = await Promise.all([readCursorRuns(store, id), journal.read()]);
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const owned = new Set<string>();
  const readings: Array<{
    turnId: string;
    createdAt: number;
    order: number;
    usage: AgentUsage | undefined;
    compacted?: boolean;
  }> = records.map((turn) => {
    const ids = new Set([
      turn.nativeRunId,
      ...(turn.executionRunIds ?? []),
      ...(turn.followUpIds ?? []),
    ]);
    let usage: TokenUsage | undefined;
    let order = 0;
    for (const runId of ids) {
      if (!runId) continue;
      owned.add(runId);
      const run = byId.get(runId);
      if (!run) continue;
      order = Math.max(order, run.turnNumber);
      if (run.usage) usage = addCursorUsage(usage, run.usage);
    }
    return {
      turnId: turn.id,
      createdAt: Date.parse(turn.createdAt),
      order,
      usage: turn.lastUsage ?? mapCursorUsage(usage),
      compacted: turn.compact === true && turn.terminal?.status === "finished",
    };
  });
  for (const run of runs) {
    if (!owned.has(run.runId) && run.usage) {
      readings.push({
        turnId: run.runId,
        createdAt: run.createdAt,
        order: run.turnNumber,
        usage: mapCursorUsage(run.usage),
      });
    }
  }
  readings.sort((a, b) => b.createdAt - a.createdAt || b.order - a.order);
  return readings;
}

export async function readCursorLastUsage(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  id: string,
) {
  const readings = await readCursorUsageHistory(store, journal, id);
  const latestIndex = readings.findIndex(({ usage }) => usage !== undefined);
  if (latestIndex === -1) return undefined;
  const latest = readings[latestIndex]!;
  const compactedAfter = readings.slice(0, latestIndex).some((entry) => entry.compacted === true);
  const usage = compactedAfter
    ? {
        ...latest.usage,
        contextWindowUsedTokens: undefined,
        contextReadingTurnId: undefined,
      }
    : latest.usage!;
  return {
    ...usage,
    tokenReadingTurnId: latest.turnId,
    ...(usage.contextWindowUsedTokens !== undefined
      ? { contextReadingTurnId: usage.contextReadingTurnId ?? latest.turnId }
      : {}),
  };
}
