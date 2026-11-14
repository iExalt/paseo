import { expect, test } from "vitest";
import { canUseSplitDiffLayout } from "./split-diff-layout";

test("side-by-side diff follows the layout width on every platform", () => {
  expect(canUseSplitDiffLayout({ isCompact: false })).toBe(true);
  expect(canUseSplitDiffLayout({ isCompact: true })).toBe(false);
});
