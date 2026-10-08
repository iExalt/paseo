import { describe, expect, test } from "vitest";

import { CompletionSubjectCollector } from "./completion-subject-collector.js";

describe("CompletionSubjectCollector", () => {
  test("joins adjacent assistant chunks and preserves an explicit message ID", () => {
    const collector = new CompletionSubjectCollector("turn-1");
    collector.observe("turn-1", { type: "assistant_message", text: "first", messageId: "m1" });
    collector.observe("turn-1", { type: "assistant_message", text: " second" });

    expect(collector.seal()).toEqual({
      turnId: "turn-1",
      text: "first second",
      completeness: "complete",
    });
  });

  test("starts a new segment when an explicit ID follows an unidentified segment", () => {
    const collector = new CompletionSubjectCollector("turn-1");
    collector.observe("turn-1", { type: "assistant_message", text: "old" });
    collector.observe("turn-1", { type: "assistant_message", text: "new", messageId: "m1" });

    expect(collector.seal()?.text).toBe("new");
  });

  test("starts a new segment after a timeline separator", () => {
    const collector = new CompletionSubjectCollector("turn-1");
    collector.observe("turn-1", { type: "assistant_message", text: "old" });
    collector.observe("turn-1", { type: "reasoning", text: "thought" });
    expect(collector.seal()?.text).toBe("old");
    collector.observe("turn-1", { type: "assistant_message", text: "new" });

    expect(collector.seal()?.text).toBe("new");
  });

  test("keeps overflow sticky until a genuinely new segment", () => {
    const collector = new CompletionSubjectCollector("turn-1", 3);
    collector.observe("turn-1", { type: "assistant_message", text: "abcd" });
    collector.observe("turn-1", { type: "assistant_message", text: "e" });

    expect(collector.seal()).toEqual({
      turnId: "turn-1",
      text: "abc",
      completeness: "incomplete",
    });

    collector.observe("turn-1", {
      type: "tool_call",
      callId: "tool-1",
      name: "tool",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "true", output: "", exitCode: 0 },
    });
    collector.observe("turn-1", { type: "assistant_message", text: "ok" });
    expect(collector.seal()).toEqual({
      turnId: "turn-1",
      text: "ok",
      completeness: "complete",
    });
  });

  test("resets sticky overflow when a different explicit message ID starts", () => {
    const collector = new CompletionSubjectCollector("turn-1", 3);
    collector.observe("turn-1", { type: "assistant_message", text: "abcd", messageId: "m1" });
    collector.observe("turn-1", { type: "assistant_message", text: "e", messageId: "m1" });

    expect(collector.seal()?.completeness).toBe("incomplete");

    collector.observe("turn-1", { type: "assistant_message", text: "ok", messageId: "m2" });

    expect(collector.seal()).toEqual({
      turnId: "turn-1",
      text: "ok",
      completeness: "complete",
    });
  });

  test("marks an immutable snapshot incomplete after another turn identity appears", () => {
    const collector = new CompletionSubjectCollector("turn-1");
    collector.observe("turn-1", { type: "assistant_message", text: "done" });
    collector.observe("turn-2", { type: "assistant_message", text: "other" });
    const subject = collector.seal();

    expect(subject).toEqual({
      turnId: "turn-1",
      text: "done",
      completeness: "incomplete",
    });
    expect(Object.isFrozen(subject)).toBe(true);
  });

  test("keeps a mismatched interleaved turn from making a later tail complete", () => {
    const collector = new CompletionSubjectCollector("turn-A");
    collector.observe("turn-A", {
      type: "assistant_message",
      text: "A significant prefix ",
      messageId: "m",
    });
    collector.observe("turn-B", {
      type: "assistant_message",
      text: "interleaved reply",
      messageId: "other",
    });
    collector.observe("turn-A", {
      type: "assistant_message",
      text: "No news.",
      messageId: "m",
    });

    expect(collector.seal()).toEqual({
      turnId: "turn-A",
      text: "No news.",
      completeness: "incomplete",
    });
  });

  test("keeps an unknown identity incomplete even when it precedes the reply", () => {
    const collector = new CompletionSubjectCollector("turn-1");
    collector.invalidate();
    collector.observe("turn-1", { type: "assistant_message", text: "possibly partial" });

    expect(collector.seal()).toEqual({
      turnId: "turn-1",
      text: "possibly partial",
      completeness: "incomplete",
    });
  });
});
