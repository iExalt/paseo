import { describe, expect, it } from "vitest";
import { expandRunTabs, expandTabs, sourceLineOffsets, sourceLineRows } from "./line-layout";

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

  it("breaks after hyphens", () => {
    expect(sourceLineRows("aaaa-bbbbbbb", 10)).toBe(2);
    expect(sourceLineRows("aaaaaaaaaaaa-b", 10)).toBe(2);
  });
});

describe("expandTabs", () => {
  it("expands to the next stop and carries the column across runs", () => {
    expect(expandTabs("\tx")).toBe("    x");
    expect(expandTabs("ab\tx")).toBe("ab  x");
    expect(expandRunTabs([{ text: "abc" }, { text: "\tx" }]).map((run) => run.text)).toEqual([
      "abc",
      " x",
    ]);
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
