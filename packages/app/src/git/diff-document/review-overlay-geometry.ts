// Narrowest frame that fits the comment editor with Cancel and Comment side by side.
export const REVIEW_OVERLAY_MIN_WIDTH = 280;

export interface ReviewOverlayFrame {
  left: number;
  width: number;
  // Relative to the top of the row's review region.
  top: number;
  height: number;
}

// Split layout gives each side's review thread its own column (same as web).
// A narrow panel (a tablet side panel is ~320dp) leaves columns too small for the
// editor: its right-aligned actions overflow left, clipping Cancel and leaving it
// untappable on Android. Those threads take the full body width instead, and the
// two sides stack so they do not overlap.
export function isReviewOverlayStacked(input: {
  viewportWidth: number;
  columnCount: number;
}): boolean {
  return (
    input.columnCount > 1 && input.viewportWidth / input.columnCount < REVIEW_OVERLAY_MIN_WIDTH
  );
}

export function resolveReviewOverlayFrame(input: {
  viewportWidth: number;
  columnCount: number;
  columnIndex: number;
  // Height of the row's whole review region (the taller side, or the sum when stacked).
  rowHeight: number;
  // Height of the thread in the left column, used to place a stacked right thread below it.
  leftHeight: number;
}): ReviewOverlayFrame {
  if (isReviewOverlayStacked(input)) {
    const isLeft = input.columnIndex === 0;
    return {
      left: 0,
      width: input.viewportWidth,
      top: isLeft ? 0 : input.leftHeight,
      height: isLeft ? input.leftHeight : input.rowHeight - input.leftHeight,
    };
  }
  const columnWidth = input.viewportWidth / input.columnCount;
  return {
    left: input.columnIndex * columnWidth,
    width: columnWidth,
    top: 0,
    height: input.rowHeight,
  };
}
