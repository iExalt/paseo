import type { StreamItem } from "@/types/stream";
import { getStreamItemMessageId } from "./presentation";

/**
 * The row where a message starts on screen in the inverted native list. Rows are held
 * newest first, including a message's own block rows, so its first block is the last
 * row of that message.
 */
export function messageStartIndex(rows: readonly StreamItem[], messageId: string): number {
  return rows.findLastIndex((row) => getStreamItemMessageId(row) === messageId);
}
