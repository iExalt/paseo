import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { locateMessageMatch } from "./message-matches";

function assistant(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) } as StreamItem;
}

describe("locateMessageMatch", () => {
  const items = [
    assistant("b", "match elsewhere"),
    assistant("a", "one **match** and `match`, then\n\n```\nmatch\n```"),
    { kind: "user_message", id: "u", text: "**match** as typed" } as StreamItem,
  ];

  it("numbers a message's occurrences in reading order, code blocks included", () => {
    expect(locateMessageMatch(items, "a", "match", 0)).toEqual({
      count: 3,
      occurrence: 0,
      itemId: "a",
      index: 0,
    });
    expect(locateMessageMatch(items, "a", "match", 2)).toMatchObject({ itemId: "a", index: 2 });
  });

  it("counts from the end for -1 and clamps past the last occurrence", () => {
    expect(locateMessageMatch(items, "a", "match", -1)).toMatchObject({ occurrence: 2 });
    expect(locateMessageMatch(items, "a", "match", 9)).toMatchObject({ occurrence: 2 });
  });

  it("searches user text as written and returns null without a match", () => {
    expect(locateMessageMatch(items, "u", "**match**", 0)).toMatchObject({ itemId: "u" });
    expect(locateMessageMatch(items, "a", "absent", 0)).toBeNull();
  });
});
