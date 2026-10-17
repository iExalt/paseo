import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { messageStartIndex } from "./message-start-index";

function block(id: string, blockGroupId: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    blockGroupId,
    text: id,
    timestamp: new Date(0),
  } as StreamItem;
}

describe("messageStartIndex", () => {
  it("finds the first block of a message held newest first", () => {
    const rows = [block("b-1", "b"), block("a-3", "a"), block("a-2", "a"), block("a-1", "a")];
    expect(messageStartIndex(rows, "a")).toBe(3);
    expect(messageStartIndex(rows, "missing")).toBe(-1);
  });
});
