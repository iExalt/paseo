// Narrowest frame that fits the comment editor with Cancel and Comment side by side.
export const REVIEW_OVERLAY_MIN_WIDTH = 280;

export interface ReviewOverlayFrame {
  left: number;
  width: number;
}

// Split layout gives each side's review thread its own column (same as web).
export function resolveReviewOverlayFrame(input: {
  viewportWidth: number;
  columnCount: number;
  columnIndex: number;
}): ReviewOverlayFrame {
  const columnWidth = input.viewportWidth / input.columnCount;
  return { left: input.columnIndex * columnWidth, width: columnWidth };
}
