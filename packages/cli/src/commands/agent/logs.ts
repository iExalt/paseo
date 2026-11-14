import { Command } from "commander";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import { connectToDaemon } from "../../utils/client.js";
import { waitForStop } from "../../utils/wait-for-stop.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
} from "../../utils/timeline.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { curateAgentActivity } from "@getpaseo/server/agent-activity";

export function addLogsOptions(cmd: Command): Command {
  return cmd
    .description("View agent activity/timeline")
    .argument("<id>", "Agent ID, prefix, or full session ID")
    .option("-f, --follow", "Follow log output (streaming)")
    .option("--tail <n>", "Show last n entries")
    .option("--filter <type>", "Filter by event type (tools, text, errors, permissions)")
    .option("--since <time>", "Show logs since timestamp")
    .option("--json", "Output lossless timeline entries and page cursors as JSON")
    .option("--full", "Print complete timeline entries as JSON, including tool details")
    .option("--limit <n>", "Fetch at most n timeline rows (0 means all)")
    .option("--before <epoch:seq>", "Fetch rows before a page cursor (default limit 200)")
    .option("--search <query>", "Find conversation text; returns matching locations")
    .option("--cursor <seq>", "Continue search at its nextCursor");
}

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean;
  tail?: string;
  filter?: string;
  since?: string;
  full?: boolean;
  limit?: string;
  before?: string;
  search?: string;
  cursor?: string;
}

// Logs command returns void - it outputs directly to console
export type AgentLogsResult = void;

export const NO_ACTIVITY_MESSAGE = "No activity to display.";

interface FetchAgentTimelineItemsOptions {
  timeoutMs?: number;
  sinceTimestampMs?: number;
}

interface FollowModeInput {
  client: DaemonClient;
  agentId: string;
  options: AgentLogsOptions;
  sinceTimestampMs: number | undefined;
}

export async function fetchAgentTimelineItems(
  client: DaemonClient,
  agentId: string,
  options?: FetchAgentTimelineItemsOptions,
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({
    client,
    agentId,
    timeoutMs: options?.timeoutMs,
    sinceTimestampMs: options?.sinceTimestampMs,
  });
}

export function formatAgentActivityTranscript(
  timelineItems: AgentTimelineItem[],
  tailCount?: number,
): string {
  if (tailCount === 0) {
    return "";
  }
  return curateAgentActivity(
    timelineItems,
    tailCount !== undefined ? { maxItems: tailCount } : undefined,
  );
}

type StreamingTextType = "assistant_message" | "reasoning";

const THOUGHT_PREFIX = "[Thought] ";

interface PendingStreamingText {
  type: StreamingTextType;
  turnId: string | undefined;
  messageId: string | undefined;
  buffer: string;
  emitted: boolean;
}

export interface FollowTranscriptWriter {
  push(item: AgentTimelineItem, turnId?: string): void;
  end(): void;
}

function lastNonWhitespaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Follow mode receives one streaming fragment per event, while the one-shot
 * transcript sees the whole timeline and merges consecutive assistant and
 * reasoning fragments with exact concatenation (`projectTimelineRows`). Printing
 * each fragment on its own line splits words at fragment boundaries and
 * reprints the reasoning prefix, so a chain of fragments is written as one
 * stream instead: text goes out as it arrives, and only the trailing whitespace
 * is held back so the message ends trimmed the way the transcript does.
 */
export function createFollowTranscriptWriter(
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
  filter?: string,
): FollowTranscriptWriter {
  let pending: PendingStreamingText | null = null;

  const emit = (chain: PendingStreamingText, text: string): void => {
    if (!chain.emitted) {
      chain.emitted = true;
      if (chain.type === "reasoning") {
        write(THOUGHT_PREFIX);
      }
    }
    write(text);
  };

  const flushContent = (chain: PendingStreamingText): void => {
    if (!chain.emitted) {
      chain.buffer = chain.buffer.replace(/^\s+/, "");
    }
    const lastContent = lastNonWhitespaceIndex(chain.buffer);
    if (lastContent < 0) {
      return;
    }
    emit(chain, chain.buffer.slice(0, lastContent + 1));
    chain.buffer = chain.buffer.slice(lastContent + 1);
  };

  const closePending = (): void => {
    const chain = pending;
    pending = null;
    if (!chain) {
      return;
    }
    const tail = chain.emitted ? chain.buffer.trimEnd() : chain.buffer.trim();
    if (tail) {
      emit(chain, tail);
    }
    if (chain.emitted) {
      write("\n");
    }
  };

  const continuesChain = (item: AgentTimelineItem, turnId: string | undefined): boolean => {
    if (!pending || pending.type !== item.type || pending.turnId !== turnId) {
      return false;
    }
    if (item.type !== "assistant_message") {
      return true;
    }
    return item.messageId === undefined || item.messageId === pending.messageId;
  };

  const startChain = (
    item: Extract<AgentTimelineItem, { type: StreamingTextType }>,
    turnId: string | undefined,
  ): PendingStreamingText => {
    closePending();
    const chain: PendingStreamingText = {
      type: item.type,
      turnId,
      messageId: item.type === "assistant_message" ? item.messageId : undefined,
      buffer: "",
      emitted: false,
    };
    pending = chain;
    return chain;
  };

  return {
    push(item, turnId) {
      if (!matchesFilter(item, filter)) {
        closePending();
        return;
      }
      if (item.type === "assistant_message" || item.type === "reasoning") {
        const chain = continuesChain(item, turnId) && pending ? pending : startChain(item, turnId);
        chain.buffer += item.text;
        flushContent(chain);
        return;
      }
      closePending();
      const transcript = formatAgentActivityTranscript([item]);
      if (transcript && transcript !== NO_ACTIVITY_MESSAGE) {
        write(`${transcript}\n`);
      }
    },
    end() {
      closePending();
    },
  };
}

function parseTailCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseSinceTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const timestampMs = Date.parse(raw);
  if (Number.isNaN(timestampMs)) {
    throw {
      code: "INVALID_TIMESTAMP",
      message: `Invalid --since value: ${raw}`,
      details: "Use a timestamp such as 2026-01-01T00:00:00Z.",
    } satisfies CommandError;
  }
  return timestampMs;
}

/**
 * Check if a timeline item matches the filter type
 */
function matchesFilter(item: AgentTimelineItem, filter?: string): boolean {
  if (!filter) return true;

  const filterLower = filter.toLowerCase();
  const type = item.type.toLowerCase();

  switch (filterLower) {
    case "tools":
      return type === "tool_call";
    case "text":
      return type === "user_message" || type === "assistant_message" || type === "reasoning";
    case "errors":
      return type === "error";
    case "permissions":
      // Permissions might be in tool_call status or a separate event type
      return type.includes("permission");
    default:
      // If filter doesn't match predefined types, match against the actual type
      return type.includes(filterLower);
  }
}

export function parseTimelineOptions(options: AgentLogsOptions) {
  const integer = (value: string | undefined, flag: string): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
      throw { code: "INVALID_ARGUMENT", message: `${flag} must be a nonnegative safe integer.` };
    }
    return parsed;
  };
  const limit = integer(options.limit, "--limit");
  const searchCursor = integer(options.cursor, "--cursor");
  const tail = integer(options.tail, "--tail");
  let cursor: { epoch: string; seq: number } | undefined;
  if (options.before !== undefined) {
    const split = options.before.lastIndexOf(":");
    const epoch = options.before.slice(0, split);
    const seq = integer(options.before.slice(split + 1), "--before sequence");
    if (split < 1 || seq === undefined) {
      throw { code: "INVALID_ARGUMENT", message: "--before requires epoch:seq." };
    }
    cursor = { epoch, seq };
  }
  const json = options.json === true || options.format === "json";
  const detailed = json || options.full;
  if (options.follow && (detailed || options.limit !== undefined || cursor)) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "--follow cannot combine with --json, --full, --limit or --before.",
    };
  }
  const searchModifiers = [
    options.before,
    options.limit,
    options.tail,
    options.since,
    options.filter,
  ];
  if (
    options.search !== undefined &&
    (options.follow || options.full || searchModifiers.some((value) => value !== undefined))
  ) {
    throw { code: "INVALID_ARGUMENT", message: "--search only combines with --json and --cursor." };
  }
  if (options.search !== undefined && !options.search.trim()) {
    throw { code: "INVALID_ARGUMENT", message: "--search must not be blank." };
  }
  if (searchCursor !== undefined && options.search === undefined) {
    throw { code: "INVALID_ARGUMENT", message: "--cursor requires --search." };
  }
  return { limit: limit ?? (cursor ? 200 : 0), cursor, searchCursor, tail, json };
}

async function printTimelinePage(
  client: DaemonClient,
  resolvedId: string,
  options: AgentLogsOptions,
  pageOptions: ReturnType<typeof parseTimelineOptions>,
  sinceTimestampMs: number | undefined,
): Promise<void> {
  const page = await client.fetchAgentTimeline(resolvedId, {
    direction: pageOptions.cursor ? "before" : "tail",
    cursor: pageOptions.cursor,
    limit: pageOptions.limit,
    wholeTurns: false,
    projection: "projected",
  });
  let entries = page.entries.filter((entry) => matchesFilter(entry.item, options.filter));
  if (sinceTimestampMs !== undefined)
    entries = entries.filter((entry) => Date.parse(entry.timestamp) >= sinceTimestampMs);
  if (pageOptions.tail !== undefined)
    entries = pageOptions.tail === 0 ? [] : entries.slice(-pageOptions.tail);
  await client.close();
  if (pageOptions.json) console.log(JSON.stringify({ ...page, entries }));
  else if (options.full) console.log(JSON.stringify({ ...page, entries }, null, 2));
  else console.log(formatAgentActivityTranscript(entries.map((entry) => entry.item)));
}

export async function runLogsCommand(
  id: string,
  options: AgentLogsOptions,
  _command: Command,
): Promise<AgentLogsResult> {
  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo agent logs <id>");
    process.exit(1);
  }

  const sinceTimestampMs = parseSinceTimestamp(options.since);
  const pageOptions = parseTimelineOptions(options);
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const resolvedId = await resolveAgentTarget(client, id);

    if (options.search !== undefined) {
      const result = await client.searchAgentTimeline({
        agentId: resolvedId,
        query: options.search,
        cursor: pageOptions.searchCursor,
      });
      await client.close();
      console.log(pageOptions.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      return;
    }
    if (
      pageOptions.json ||
      options.full ||
      options.limit !== undefined ||
      options.before !== undefined
    ) {
      await printTimelinePage(client, resolvedId, options, pageOptions, sinceTimestampMs);
      return;
    }

    // For follow mode, we stream events continuously
    if (options.follow) {
      if (options.tail !== undefined && parseTailCount(options.tail) === undefined) {
        console.error(`Error: Invalid --tail value: ${options.tail}`);
        console.error("Usage: --tail <n> (where n is >= 0)");
        await client.close().catch(() => {});
        process.exit(1);
      }
      await runFollowMode({
        client,
        agentId: resolvedId,
        options,
        sinceTimestampMs,
      });
      return;
    }

    // Fetch timeline directly via cursor RPC.
    let timelineItems = await fetchAgentTimelineItems(client, resolvedId, {
      sinceTimestampMs,
    });

    // Apply filter
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter));
    }

    const tailCount = parseTailCount(options.tail);
    if (options.tail !== undefined && tailCount === undefined) {
      console.error(`Error: Invalid --tail value: ${options.tail}`);
      console.error("Usage: --tail <n> (where n is >= 0)");
      await client.close().catch(() => {});
      process.exit(1);
    }

    await client.close();

    // Use curateAgentActivity to format the transcript
    if (tailCount === 0) {
      return;
    }

    const transcript = formatAgentActivityTranscript(timelineItems, tailCount);
    console.log(transcript);
  } catch (err) {
    await client.close().catch(() => {});
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to get logs: ${message}`);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode({
  client,
  agentId,
  options,
  sinceTimestampMs,
}: FollowModeInput): Promise<void> {
  const DEFAULT_FOLLOW_TAIL = 10;
  const tailCount = parseTailCount(options.tail) ?? DEFAULT_FOLLOW_TAIL;

  // First, get existing timeline.
  let existingItems: AgentTimelineItem[] = [];
  try {
    existingItems = await fetchAgentTimelineItems(client, agentId, {
      timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
      sinceTimestampMs,
    });
  } catch (error) {
    console.warn("Warning: failed to fetch existing timeline", error);
  }

  // Apply filter to existing items
  if (options.filter) {
    existingItems = existingItems.filter((item) => matchesFilter(item, options.filter));
  }

  // Print existing transcript (tail-like behavior)
  if (tailCount > 0) {
    const existingTranscript = formatAgentActivityTranscript(existingItems, tailCount);
    if (existingTranscript !== NO_ACTIVITY_MESSAGE) {
      console.log(existingTranscript);
    }
  }

  // Subscribe to new events
  const tailLabel =
    tailCount === 0 ? "no history" : `last ${tailCount} entr${tailCount === 1 ? "y" : "ies"}`;

  const writer = createFollowTranscriptWriter(undefined, options.filter);

  const unsubscribe = client.subscribeAgentTimeline(agentId, (message) => {
    if (message.type === "agent.timeline.replacement") {
      writer.end();
      console.log("\n[Timeline replaced; earlier output is no longer current]");
      return;
    }

    if (message.type === "agent.timeline.error") {
      writer.end();
      console.error(`Timeline observation stopped: ${message.payload.error}`);
      return;
    }
    if (message.type === "agent.timeline.subscription_restored") {
      writer.end();
      console.log("\n[Reconnected; live output resumed. Events may have been missed.]");
      return;
    }
    if (message.payload.event.type === "timeline") {
      const matchesSince =
        sinceTimestampMs === undefined || Date.parse(message.payload.timestamp) >= sinceTimestampMs;
      if (!matchesSince) {
        return;
      }
      const item = message.payload.event.item;
      writer.push(item, message.payload.event.turnId);
    } else if (
      message.payload.event.type === "turn_completed" ||
      message.payload.event.type === "turn_failed" ||
      message.payload.event.type === "turn_canceled"
    ) {
      writer.end();
    }
  });

  await unsubscribe.ready;
  console.log(`\n--- Following logs (${tailLabel}; Ctrl+C to stop) ---\n`);

  await waitForStop();
  writer.end();
  unsubscribe();
  await client.close();
}

export async function runPromptsCommand(id: string, options: CommandOptions): Promise<void> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const agentId = await resolveAgentTarget(client, id);
    const result = await client.listAgentTimelinePrompts(agentId);
    const json = options.json === true || options.format === "json";
    console.log(JSON.stringify(result, null, json ? undefined : 2));
  } finally {
    await client.close();
  }
}
