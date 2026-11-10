import { describe, expect, it } from "vitest";
import { readerBottomOverlap } from "./reader-bottom-overlap";

describe("reader bottom overlap", () => {
  it("adds only the part of a system bar covering the reader", () => {
    const base = { windowHeight: 800, bottomInset: 40 };
    expect(readerBottomOverlap({ ...base, frameTop: 100, frameHeight: 700 })).toBe(40);
    expect(readerBottomOverlap({ ...base, frameTop: 100, frameHeight: 680 })).toBe(20);
    expect(readerBottomOverlap({ ...base, frameTop: 100, frameHeight: 660 })).toBe(0);
    expect(readerBottomOverlap({ ...base, frameTop: 790, frameHeight: 10 })).toBe(10);
    expect(readerBottomOverlap({ ...base, frameTop: 800, frameHeight: 0 })).toBe(0);
  });
});
