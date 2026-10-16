import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { countMessageMatches } from "./message-matches";

function assistant(id: string, text: string, blockGroupId?: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(0),
    ...(blockGroupId ? { blockGroupId } : {}),
  } as StreamItem;
}

describe("countMessageMatches", () => {
  it("counts what the reader sees, not Markdown syntax or link targets", () => {
    const items = [assistant("a", "**Paseo** links [here](https://paseo.sh) and `paseo`")];
    expect(countMessageMatches(items, "a", "paseo")).toBe(2);
  });

  it("matches across any whitespace and counts code blocks", () => {
    const items = [assistant("a", "find  me\n\n```\nfind me\n```")];
    expect(countMessageMatches(items, "a", "find me")).toBe(2);
  });

  it("adds up every block row of one message and ignores other messages", () => {
    const items = [
      assistant("a-1", "one match", "a"),
      assistant("a-2", "another match", "a"),
      assistant("b", "match"),
      { kind: "user_message", id: "u", text: "**match** as typed" } as StreamItem,
    ];
    expect(countMessageMatches(items, "a", "match")).toBe(2);
    expect(countMessageMatches(items, "u", "**match**")).toBe(1);
  });
});
