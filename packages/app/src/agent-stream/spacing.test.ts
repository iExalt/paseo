import { describe, expect, it } from "vitest";
import { getAssistantMessageSpacing, getGapBetweenStreamItems } from "./spacing";
import type { StreamItem } from "@/types/stream";
const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("keeps separate messages separated", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBeGreaterThan(0);
  });
});

describe("received message spacing", () => {
  const at = new Date(0);
  const received = (id: string, turnId: string): StreamItem => ({
    kind: "user_message",
    id,
    turnId,
    text: "Ready",
    timestamp: at,
    sender: { id: "worker" },
  });
  const work: StreamItem = {
    kind: "tool_call",
    id: "work",
    turnId: "t1",
    timestamp: at,
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "work",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "ls" },
      },
    },
  } as StreamItem;
  const prompt: StreamItem = { kind: "user_message", id: "prompt", text: "Go", timestamp: at };

  it("keeps a turn's gap above the row and stays close to the rest of its turn", () => {
    expect(getGapBetweenStreamItems(message, received("r1", "t1"))).toBe(16);
    expect(getGapBetweenStreamItems(prompt, received("r1", "t1"))).toBe(16);
    expect(getGapBetweenStreamItems(received("r1", "t1"), work)).toBe(4);
    expect(getGapBetweenStreamItems(received("r1", "t1"), received("r2", "t1"))).toBe(4);
    expect(getGapBetweenStreamItems(received("r1", "t0"), received("r2", "t1"))).toBe(16);
    expect(getGapBetweenStreamItems(prompt, work)).toBe(16);
  });
});
