import { describe, expect, test } from "vitest";

import { CompletionSubjectCollector } from "./completion-subject-collector.js";
import { ReplyRuleMatcher } from "./reply-rule-matcher.js";

function subject(text: string, completeness: "complete" | "incomplete" = "complete") {
  return { turnId: "turn-1", text, completeness } as const;
}

describe("ReplyRuleMatcher", () => {
  test("uses search semantics and anchors for whole-subject matching", () => {
    expect(
      ReplyRuleMatcher.compile([{ source: "hello", flags: "" }]).matches(
        subject("well hello there"),
      ),
    ).toBe(true);
    expect(
      ReplyRuleMatcher.compile([{ source: "^hello$", flags: "" }]).matches(
        subject("well hello there"),
      ),
    ).toBe(false);
    expect(
      ReplyRuleMatcher.compile([{ source: "^hello$", flags: "" }]).matches(subject("hello")),
    ).toBe(true);
  });

  test("applies case, multiline, and Unicode flags with Unicode implicit", () => {
    expect(
      ReplyRuleMatcher.compile([{ source: "hello", flags: "i" }]).matches(subject("HELLO")),
    ).toBe(true);
    expect(
      ReplyRuleMatcher.compile([{ source: "^hello$", flags: "m" }]).matches(
        subject("other\nhello\nlast"),
      ),
    ).toBe(true);
    expect(ReplyRuleMatcher.compile([{ source: "^.$", flags: "" }]).matches(subject("😀"))).toBe(
      true,
    );
  });

  test("rejects unsupported, duplicate, malformed, and over-limit candidates", () => {
    expect(() => ReplyRuleMatcher.compile([{ source: "a", flags: "g" }])).toThrow(/Unsupported/);
    expect(() => ReplyRuleMatcher.compile([{ source: "a", flags: "ii" }])).toThrow(/Duplicate/);
    expect(() => ReplyRuleMatcher.compile([{ source: "(?=a)", flags: "" }])).toThrow();
    expect(() => ReplyRuleMatcher.compile([{ source: "\\1", flags: "" }])).toThrow();
    expect(() => ReplyRuleMatcher.compile([{ source: "a".repeat(257), flags: "" }])).toThrow(/256/);
    const tooManyRules = Array.from({ length: 9 }, () => ({ source: "a", flags: "" }));
    expect(() => ReplyRuleMatcher.compile(tooManyRules)).toThrow(/8/);
  });

  test("fails open for absent, incomplete, and oversized subjects", () => {
    const matcher = ReplyRuleMatcher.compile([{ source: ".+", flags: "" }]);
    const oversized = new CompletionSubjectCollector("turn-1", 16_385);
    oversized.observe("turn-1", { type: "assistant_message", text: "a".repeat(16_385) });

    expect(matcher.matches(undefined)).toBe(false);
    expect(matcher.matches(subject("match", "incomplete"))).toBe(false);
    expect(matcher.matches(subject("a".repeat(16_385)))).toBe(false);
    expect(matcher.matches(oversized.seal())).toBe(false);
  });
});
