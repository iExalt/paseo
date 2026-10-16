import MarkdownIt from "markdown-it";
import { countMatches, searchableBlocks, searchPattern } from "@getpaseo/protocol/chat-search-text";
import type { StreamItem } from "@/types/stream";
import { getStreamItemMessageId } from "../presentation";

const markdown = new MarkdownIt({ html: false });

/**
 * Occurrences of the query in a message, counted the way the host's chat search counts
 * them: assistant Markdown by rendered block, user text as written. A message can span
 * several stream items (one per Markdown block), so every item of it is counted.
 */
export function countMessageMatches(
  items: readonly StreamItem[],
  messageId: string,
  query: string,
): number {
  if (!query.trim()) return 0;
  const pattern = searchPattern(query);
  let count = 0;
  for (const item of items) {
    if (getStreamItemMessageId(item) !== messageId) continue;
    if (item.kind === "user_message") {
      count += countMatches(item.text.replace(/\r/g, ""), pattern);
    } else if (item.kind === "assistant_message") {
      for (const block of searchableBlocks(markdown.parse(item.text.replace(/\r/g, ""), {}))) {
        count += countMatches(block, pattern);
      }
    }
  }
  return count;
}
