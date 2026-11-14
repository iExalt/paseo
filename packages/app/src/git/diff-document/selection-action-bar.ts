// Placement for the native diff's floating Copy / Select all bar. It runs in an
// animated style so the bar follows scrolling without re-rendering.

/** Space between the bar and the caret it points at. */
export const SELECTION_ACTION_BAR_GAP = 8;
/** The bar keeps this distance from the viewport's edges. */
export const SELECTION_ACTION_BAR_MARGIN = 8;

/** A selection end in viewport x and document y. */
export interface SelectionActionBarCaret {
  x: number;
  top: number;
  bottom: number;
}

export interface SelectionActionBarPlacement {
  left: number;
  top: number;
}

/**
 * Prefers the space above the start caret, then below the end caret (and its
 * handle). A selection taller than the viewport pins the bar to the top edge;
 * one scrolled fully out of view hides it (null).
 */
export function placeSelectionActionBar(input: {
  start: SelectionActionBarCaret;
  end: SelectionActionBarCaret;
  /** Space a handle hangs below the end caret. */
  endHandleHeight: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  barWidth: number;
  barHeight: number;
}): SelectionActionBarPlacement | null {
  "worklet";
  const startTop = input.start.top - input.scrollTop;
  const endBottom = input.end.bottom - input.scrollTop;
  if (endBottom < 0 || startTop > input.viewportHeight) return null;
  const minTop = SELECTION_ACTION_BAR_MARGIN;
  const maxTop = input.viewportHeight - SELECTION_ACTION_BAR_MARGIN - input.barHeight;
  const above = startTop - SELECTION_ACTION_BAR_GAP - input.barHeight;
  const below = endBottom + input.endHandleHeight + SELECTION_ACTION_BAR_GAP;
  let top = above;
  let caretX = input.start.x;
  if (above < minTop) {
    if (below <= maxTop) {
      top = below;
      caretX = input.end.x;
    } else {
      top = Math.max(minTop, Math.min(above, maxTop));
    }
  }
  const maxLeft = input.viewportWidth - SELECTION_ACTION_BAR_MARGIN - input.barWidth;
  const left = Math.max(
    SELECTION_ACTION_BAR_MARGIN,
    Math.min(caretX - input.barWidth / 2, maxLeft),
  );
  return { left, top };
}
