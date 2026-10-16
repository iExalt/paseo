import { describe, expect, it } from "vitest";
import { findRevealDelta, lineAtOffset, scrollOffsetForDelta } from "./reveal";

describe("lineAtOffset", () => {
  const lines = [
    { text: "first line ", y: 0, height: 20 },
    { text: "second\n", y: 20, height: 20 },
    { text: "third", y: 40, height: 20 },
  ];

  it("finds the line whose start is the last at or before the offset", () => {
    expect(lineAtOffset(lines, 0)).toEqual({ y: 0, height: 20 });
    expect(lineAtOffset(lines, 11)).toEqual({ y: 20, height: 20 });
    expect(lineAtOffset(lines, 19)).toEqual({ y: 40, height: 20 });
    expect(lineAtOffset([], 3)).toBeNull();
  });
});

describe("findRevealDelta", () => {
  const band = { visibleTop: 100, visibleBottom: 500, margin: 10 };

  it("leaves a visible match alone", () => {
    expect(findRevealDelta({ ...band, matchTop: 200, matchHeight: 20 })).toBe(0);
  });

  it("moves content up for a match below the band and down for one above it", () => {
    expect(findRevealDelta({ ...band, matchTop: 600, matchHeight: 20 })).toBe(130);
    expect(findRevealDelta({ ...band, matchTop: 40, matchHeight: 20 })).toBe(-70);
  });

  it("aligns the top of a match taller than the band", () => {
    expect(findRevealDelta({ ...band, matchTop: 300, matchHeight: 900 })).toBe(190);
  });
});

describe("scrollOffsetForDelta", () => {
  it("scrolls an inverted list the other way and never past its start", () => {
    expect(scrollOffsetForDelta(400, 130, false)).toBe(530);
    expect(scrollOffsetForDelta(400, 130, true)).toBe(270);
    expect(scrollOffsetForDelta(50, 130, true)).toBe(0);
  });
});
