import MarkdownIt from "markdown-it";
import { countMatches, searchableBlocks, searchPattern } from "@getpaseo/protocol/chat-search-text";
import { setImmediate } from "node:timers/promises";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { projectTimelineRows } from "../timeline-projection.js";

const markdown = new MarkdownIt({ html: false });
const PAGE_SIZE = 200;
interface SearchLocation {
  seq: number;
  role: "user" | "assistant";
  count: number;
}
interface SearchInput {
  rows: readonly AgentTimelineRow[];
  query: string;
  cursor?: number;
}

// Discovery is deliberately approximate. Only the client can verify displayed text, so
// `count` estimates rendered occurrences and the client replaces it with the rendered
// count once the message is on screen.
export async function searchTimeline({ rows, query, cursor = 0 }: SearchInput) {
  const locations: SearchLocation[] = [];
  if (!query.trim()) return { locations, nextCursor: null };
  const pattern = searchPattern(query);
  let lastYield = performance.now();
  for (const entry of projectTimelineRows({ rows, mode: "projected" })) {
    if (entry.seqEnd <= cursor) continue;
    const item = entry.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const raw = item.text.replace(/\r/g, "");
    const blocks =
      item.type === "assistant_message" ? searchableBlocks(markdown.parse(raw, {})) : [raw];
    const count = blocks.reduce((sum, block) => sum + countMatches(block, pattern), 0);
    if (count) {
      if (locations.length === PAGE_SIZE) {
        return { locations, nextCursor: locations[PAGE_SIZE - 1]!.seq };
      }
      locations.push({
        seq: entry.seqEnd,
        role: item.type === "user_message" ? "user" : "assistant",
        count,
      });
    }
    if (performance.now() - lastYield >= 8) {
      await setImmediate();
      lastYield = performance.now();
    }
  }
  return { locations, nextCursor: null };
}
