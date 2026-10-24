import { describe, expect, it } from "vitest";
import { REVIEW_OVERLAY_MIN_WIDTH, resolveReviewOverlayFrame } from "./review-overlay-geometry";

describe("resolveReviewOverlayFrame", () => {
  it("spans the whole body in unified layout", () => {
    expect(
      resolveReviewOverlayFrame({ viewportWidth: 320, columnCount: 1, columnIndex: 0 }),
    ).toEqual({ left: 0, width: 320 });
  });

  it("keeps each split thread under its own column when the column fits the editor", () => {
    const viewportWidth = REVIEW_OVERLAY_MIN_WIDTH * 2;
    expect(resolveReviewOverlayFrame({ viewportWidth, columnCount: 2, columnIndex: 0 })).toEqual({
      left: 0,
      width: REVIEW_OVERLAY_MIN_WIDTH,
    });
    expect(resolveReviewOverlayFrame({ viewportWidth, columnCount: 2, columnIndex: 1 })).toEqual({
      left: REVIEW_OVERLAY_MIN_WIDTH,
      width: REVIEW_OVERLAY_MIN_WIDTH,
    });
  });

  it("widens a split thread to the body width when a column is too narrow for the editor", () => {
    // A ~320dp side panel gives 160dp columns, which clipped Cancel off the left edge.
    for (const columnIndex of [0, 1]) {
      expect(
        resolveReviewOverlayFrame({ viewportWidth: 320, columnCount: 2, columnIndex }),
      ).toEqual({ left: 0, width: 320 });
    }
  });
});
