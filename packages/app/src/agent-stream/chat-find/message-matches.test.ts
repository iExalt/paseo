import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { locateMessageMatch } from "./message-matches";

function assistant(id: string, text: string, blockGroupId?: string, blockIndex = 0): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(0),
    ...(blockGroupId ? { blockGroupId, blockIndex } : {}),
  } as StreamItem;
}

describe("locateMessageMatch", () => {
  // Native holds rows newest first, a message's own block rows included.
  const items = [
    assistant("a-3", "last match", "a", 2),
    assistant("b", "match elsewhere"),
    assistant("a-2", "one **match** and `match`", "a", 1),
    assistant("a-1", "nothing here", "a", 0),
    { kind: "user_message", id: "u", text: "**match** as typed" } as StreamItem,
  ];

  it("maps a message occurrence onto the item that draws it, skipping items without one", () => {
    expect(locateMessageMatch(items, "a", "match", 0)).toEqual({
      count: 3,
      occurrence: 0,
      itemId: "a-2",
      index: 0,
    });
    expect(locateMessageMatch(items, "a", "match", 1)).toMatchObject({ itemId: "a-2", index: 1 });
    expect(locateMessageMatch(items, "a", "match", 2)).toMatchObject({ itemId: "a-3", index: 0 });
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
