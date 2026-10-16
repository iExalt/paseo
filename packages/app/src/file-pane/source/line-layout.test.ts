import { describe, expect, it } from "vitest";
import { sourceLineOffsets, sourceLineRows } from "./line-layout";

describe("sourceLineRows", () => {
  it("keeps short and empty lines on one row", () => {
    expect(sourceLineRows("", 10)).toBe(1);
    expect(sourceLineRows("short", 10)).toBe(1);
    expect(sourceLineRows("exactly10!", 10)).toBe(1);
  });

  it("wraps at spaces and lets trailing spaces hang", () => {
    expect(sourceLineRows("aaaa bbbb cccc", 10)).toBe(2);
    expect(sourceLineRows("aaaaaaaaa     ", 10)).toBe(1);
  });

  it("breaks a word longer than a row inside it", () => {
    expect(sourceLineRows("a".repeat(25), 10)).toBe(3);
    expect(sourceLineRows(`ab ${"c".repeat(12)}`, 10)).toBe(3);
  });

  it("expands tabs to the next tab stop", () => {
    expect(sourceLineRows("\tx", 8)).toBe(2);
    expect(sourceLineRows("ab\tx", 9)).toBe(1);
  });
});

describe("sourceLineOffsets", () => {
  it("sums row heights and follows the width", () => {
    const lines = ["one", "x".repeat(30), ""];
    const cell = { charWidth: 7, lineHeight: 18 };
    expect([...sourceLineOffsets(lines, 140, cell)]).toEqual([0, 18, 54, 72]);
    expect([...sourceLineOffsets(lines, 70, cell)]).toEqual([0, 18, 72, 90]);
  });
});
