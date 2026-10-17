import { describe, expect, it } from "vitest";
import { paneSplitsAvailable } from "@/constants/layout";

describe("paneSplitsAvailable", () => {
  it("splits panes on every platform once the layout is not compact", () => {
    expect(paneSplitsAvailable({ isCompact: false })).toBe(true);
    expect(paneSplitsAvailable({ isCompact: true })).toBe(false);
  });
});
