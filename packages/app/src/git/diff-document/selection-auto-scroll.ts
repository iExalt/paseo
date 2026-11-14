import type { DiffDocumentModel } from "./types";
import type { SelectionGesturePoint } from "./selection-gesture";

// Edge auto-scroll for the native diff's selection drags. Gesture handlers only
// report when the finger moves, so a finger held still near an edge would never
// extend the selection on its own. A per-frame tick scrolls the list and maps
// the finger's last viewport position back to a document point at the new
// scroll offset.

/** How far from the viewport's top or bottom edge auto-scroll starts. */
export const SELECTION_AUTO_SCROLL_EDGE = 64;
/** Top speed, in px per 60 Hz frame, reached at or past the edge. */
export const SELECTION_AUTO_SCROLL_MAX_STEP = 20;
const FRAME_MS = 1000 / 60;
/** A stalled frame scrolls at most this much time's worth. */
const MAX_ELAPSED_MS = 3 * FRAME_MS;

/**
 * The scroll step for a finger at `viewportY`: negative near the top edge,
 * positive near the bottom, zero elsewhere. It grows linearly with how deep the
 * finger is in the edge zone and caps at the edge itself (or beyond it).
 */
export function selectionAutoScrollStep(viewportY: number, viewportHeight: number): number {
  const zone = Math.min(SELECTION_AUTO_SCROLL_EDGE, viewportHeight / 4);
  if (zone <= 0) return 0;
  const topDepth = zone - viewportY;
  if (topDepth > 0) return -SELECTION_AUTO_SCROLL_MAX_STEP * Math.min(1, topDepth / zone);
  const bottomDepth = viewportY - (viewportHeight - zone);
  if (bottomDepth > 0) return SELECTION_AUTO_SCROLL_MAX_STEP * Math.min(1, bottomDepth / zone);
  return 0;
}

/** The next scroll offset for one frame, or null when the list should stay put. */
export function nextSelectionAutoScrollTop(input: {
  viewportY: number;
  viewportHeight: number;
  scrollTop: number;
  maxScrollTop: number;
  elapsedMs: number;
}): number | null {
  const step = selectionAutoScrollStep(input.viewportY, input.viewportHeight);
  if (step === 0) return null;
  const elapsed = Math.min(Math.max(input.elapsedMs, 0), MAX_ELAPSED_MS);
  const next = Math.min(
    Math.max(input.scrollTop + (step * elapsed) / FRAME_MS, 0),
    Math.max(input.maxScrollTop, 0),
  );
  return next === input.scrollTop ? null : next;
}

/**
 * A running selection drag's finger in diff-viewport coordinates: where it was
 * when the drag started plus how far it has moved since. Viewport coordinates
 * don't change when the list scrolls under a still finger, so the document
 * point is always `viewport + scrollTop`.
 */
export interface SelectionDragPointer {
  /** The file whose body coordinates the reducer receives. */
  fileIndex: number;
  originX: number;
  originY: number;
  deltaX: number;
  deltaY: number;
}

/**
 * Starts a long-press drag pointer. `bodyX`/`bodyY` are the gesture's position
 * in the pressed file's body, which scrolls with the content; at the press the
 * viewport y is the body y moved by the body's top and the scroll offset. Later
 * moves pass the finger's absolute movement as the delta, never the body y.
 */
export function longPressDragPointer(input: {
  model: DiffDocumentModel;
  fileIndex: number;
  bodyX: number;
  bodyY: number;
  scrollTop: number;
}): SelectionDragPointer | null {
  const file = input.model.files[input.fileIndex];
  if (!file) return null;
  return {
    fileIndex: input.fileIndex,
    originX: input.bodyX,
    originY: file.bodyTop + input.bodyY - input.scrollTop,
    deltaX: 0,
    deltaY: 0,
  };
}

/**
 * Starts a handle drag pointer at the caret's middle; `caretViewportX` already
 * includes the horizontal offset. The delta is the pan's translation.
 */
export function handleDragPointer(input: {
  fileIndex: number;
  caretViewportX: number;
  caretMiddleY: number;
  scrollTop: number;
}): SelectionDragPointer {
  return {
    fileIndex: input.fileIndex,
    originX: input.caretViewportX,
    originY: input.caretMiddleY - input.scrollTop,
    deltaX: 0,
    deltaY: 0,
  };
}

export function selectionDragViewportY(pointer: SelectionDragPointer): number {
  return pointer.originY + pointer.deltaY;
}

/** The reducer's drag point for the finger at the current scroll offset. */
export function selectionDragPoint(
  model: DiffDocumentModel,
  pointer: SelectionDragPointer,
  scrollTop: number,
): SelectionGesturePoint | null {
  const file = model.files[pointer.fileIndex];
  if (!file) return null;
  return {
    file,
    locationX: pointer.originX + pointer.deltaX,
    locationY: selectionDragViewportY(pointer) + scrollTop - file.bodyTop,
  };
}
