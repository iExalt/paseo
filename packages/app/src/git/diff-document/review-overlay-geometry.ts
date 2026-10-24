// Narrowest frame that fits the comment editor with Cancel and Comment side by side.
export const REVIEW_OVERLAY_MIN_WIDTH = 280;

export interface ReviewOverlayFrame {
  left: number;
  width: number;
}

// Split layout gives each side's review thread its own column (same as web).
// A narrow panel (a tablet side panel is ~320dp) leaves columns too small for the
// editor: its right-aligned actions overflow left, clipping Cancel and leaving it
// untappable on Android. Those threads take the full body width instead.
export function resolveReviewOverlayFrame(input: {
  viewportWidth: number;
  columnCount: number;
  columnIndex: number;
}): ReviewOverlayFrame {
  const columnWidth = input.viewportWidth / input.columnCount;
  if (input.columnCount > 1 && columnWidth < REVIEW_OVERLAY_MIN_WIDTH) {
    return { left: 0, width: input.viewportWidth };
  }
  return { left: input.columnIndex * columnWidth, width: columnWidth };
}
