import { countMatches, searchPattern } from "@getpaseo/protocol/chat-search-text";
import { capAssistantMessageForRender } from "@/components/assistant-message-render-limit";
import type { StreamItem } from "@/types/stream";
import { getStreamItemMessageId } from "../presentation";
import { findMarkdownMatches } from "./markdown-matches";

/** An occurrence of the query, as the stream item that draws it and its number there. */
export interface MessageMatch {
  /** Occurrences in the whole message. */
  count: number;
  /** Which occurrence this is, clamped into the message; -1 counts from the end. */
  occurrence: number;
  itemId: string;
  index: number;
}

function blockIndex(row: StreamItem): number {
  return row.kind === "assistant_message" ? (row.blockIndex ?? 0) : 0;
}

/** The text a row draws: native never expands a capped message. */
function itemMatchCount(item: StreamItem, pattern: RegExp): number {
  if (item.kind === "user_message") return countMatches(item.text, pattern);
  if (item.kind === "assistant_message") {
    return findMarkdownMatches(capAssistantMessageForRender(item.text).text, pattern).count;
  }
  return 0;
}

/**
 * Finds an occurrence in a message, counted the way the host's chat search counts
 * them. Pass the rows the stream draws: an assistant message is one row per Markdown
 * block, so the occurrence is numbered across its rows in block order, whatever order
 * the list holds them in. Null when there is none.
 */
export function locateMessageMatch(
  rows: readonly StreamItem[],
  messageId: string,
  query: string,
  occurrence: number,
): MessageMatch | null {
  if (!query.trim()) return null;
  const pattern = searchPattern(query);
  const counts = rows
    .filter((row) => getStreamItemMessageId(row) === messageId)
    .sort((a, b) => blockIndex(a) - blockIndex(b))
    .map((row) => ({ itemId: row.id, count: itemMatchCount(row, pattern) }));
  const count = counts.reduce((total, entry) => total + entry.count, 0);
  if (count === 0) return null;
  const target = occurrence < 0 ? count - 1 : Math.min(occurrence, count - 1);
  let before = 0;
  for (const entry of counts) {
    if (target < before + entry.count) {
      return { count, occurrence: target, itemId: entry.itemId, index: target - before };
    }
    before += entry.count;
  }
  return null;
}
