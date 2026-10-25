import { describe, expect, it } from "vitest";
import {
  isReviewOverlayStacked,
  REVIEW_OVERLAY_MIN_WIDTH,
  resolveReviewOverlayFrame,
} from "./review-overlay-geometry";

const HEIGHTS = { rowHeight: 226, leftHeight: 88 };

describe("resolveReviewOverlayFrame", () => {
  it("spans the whole body in unified layout", () => {
    expect(
      resolveReviewOverlayFrame({
        viewportWidth: 320,
        columnCount: 1,
        columnIndex: 0,
        ...HEIGHTS,
      }),
    ).toEqual({ left: 0, width: 320, top: 0, height: 226 });
  });

  it("keeps each split thread under its own column when the column fits the editor", () => {
    const viewportWidth = REVIEW_OVERLAY_MIN_WIDTH * 2;
    expect(isReviewOverlayStacked({ viewportWidth, columnCount: 2 })).toBe(false);
    expect(
      resolveReviewOverlayFrame({ viewportWidth, columnCount: 2, columnIndex: 0, ...HEIGHTS }),
    ).toEqual({ left: 0, width: REVIEW_OVERLAY_MIN_WIDTH, top: 0, height: 226 });
    expect(
      resolveReviewOverlayFrame({ viewportWidth, columnCount: 2, columnIndex: 1, ...HEIGHTS }),
    ).toEqual({
      left: REVIEW_OVERLAY_MIN_WIDTH,
      width: REVIEW_OVERLAY_MIN_WIDTH,
      top: 0,
      height: 226,
    });
  });

  it("stacks full-width split threads when a column is too narrow for the editor", () => {
    // A ~320dp side panel gives 160dp columns, which clipped Cancel off the left edge.
    expect(isReviewOverlayStacked({ viewportWidth: 320, columnCount: 2 })).toBe(true);
    const left = resolveReviewOverlayFrame({
      viewportWidth: 320,
      columnCount: 2,
      columnIndex: 0,
      rowHeight: 220,
      leftHeight: 88,
    });
    const right = resolveReviewOverlayFrame({
      viewportWidth: 320,
      columnCount: 2,
      columnIndex: 1,
      rowHeight: 220,
      leftHeight: 88,
    });
    expect(left).toEqual({ left: 0, width: 320, top: 0, height: 88 });
    expect(right).toEqual({ left: 0, width: 320, top: left.height, height: 132 });
  });
});
