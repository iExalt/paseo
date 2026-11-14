import { describe, expect, it } from "vitest";
import { resolveRevealScrollTop } from "./reveal";

const band = { visibleTop: 100, visibleBottom: 700, scrollTop: 400 };

describe("resolveRevealScrollTop", () => {
  it("leaves an element that is already visible", () => {
    expect(resolveRevealScrollTop({ ...band, elementTop: 300, elementBottom: 700 })).toBeNull();
  });

  it("scrolls an element below the band up by its overlap", () => {
    expect(resolveRevealScrollTop({ ...band, elementTop: 1300, elementBottom: 1450 })).toBe(1150);
  });

  it("aligns the top of an element above the band", () => {
    expect(resolveRevealScrollTop({ ...band, elementTop: 40, elementBottom: 190 })).toBe(340);
  });

  it("aligns the top of an element taller than the band", () => {
    expect(resolveRevealScrollTop({ ...band, elementTop: 500, elementBottom: 1200 })).toBe(800);
    expect(resolveRevealScrollTop({ ...band, elementTop: 100, elementBottom: 1200 })).toBeNull();
  });
});
