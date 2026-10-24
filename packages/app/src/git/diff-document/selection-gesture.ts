import { comparePosition, orderedSelection, selectCellSource } from "./hit-testing";
import type { DiffHorizontalOffsets } from "./horizontal-offsets";
import {
  extendNativeSelection,
  nativeSelectionEdgePosition,
  nativeSelectionPositionAtBodyPoint,
} from "./native-selection";
import type {
  DiffCharacterPosition,
  DiffDocumentModel,
  DiffFileSection,
  DiffSelection,
} from "./types";

// The native diff's selection gesture as a pure state machine. Touch, long-press
// and handle callbacks feed it events; it returns the next selection and what a
// finished tap should do. Hit-testing happens here so the split side lock and
// the "hold the last focus" rule live in one place.

/** A quick tap opens a comment (or dismisses a selection) below these limits. */
export const SELECTION_TAP_MAX_DURATION_MS = 500;
export const SELECTION_TAP_MAX_DISTANCE = 10;
/** Hold time before a press turns into a selection; matches the tap limit. */
export const SELECTION_LONG_PRESS_MS = SELECTION_TAP_MAX_DURATION_MS;

export type SelectionHandle = "start" | "end";

export type SelectionGestureState =
  | { kind: "idle" }
  | { kind: "pressing"; x: number; y: number; startedAt: number; moved: boolean }
  /** A long-press drag; `origin` is the cell the press selected. */
  | { kind: "selecting"; origin: DiffSelection; lockCellIndex: number }
  | { kind: "dragging-handle"; anchor: DiffCharacterPosition; lockCellIndex: number };

export const IDLE_SELECTION_GESTURE: SelectionGestureState = { kind: "idle" };

/** A touch in `file`'s body coordinates; it may land outside `file`. */
export interface SelectionGesturePoint {
  file: DiffFileSection;
  locationX: number;
  locationY: number;
}

export type SelectionGestureEvent =
  /** Responder touches on a file body, in page coordinates. */
  | { type: "touch-start"; pageX: number; pageY: number; time: number }
  | { type: "touch-move"; pageX: number; pageY: number }
  | { type: "touch-end"; time: number }
  | { type: "touch-cancel" }
  | { type: "long-press"; point: SelectionGesturePoint }
  | { type: "handle-start"; handle: SelectionHandle }
  /** The finger of a long-press or handle drag moved. */
  | { type: "drag"; point: SelectionGesturePoint }
  | { type: "drag-end"; source: "long-press" | "handle" };

/** `dismiss` cleared the selection; `comment` asks the caller to open a review comment. */
export type SelectionGestureEffect = "none" | "dismiss" | "comment";

export interface SelectionGestureResult {
  state: SelectionGestureState;
  selection: DiffSelection | null;
  effect: SelectionGestureEffect;
}

export interface SelectionGestureContext {
  model: DiffDocumentModel;
  horizontalOffsets: Readonly<DiffHorizontalOffsets>;
}

/** Scroll and the panel gestures stay off only while one of these drags runs. */
export function isSelectionDragActive(state: SelectionGestureState): boolean {
  return state.kind === "selecting" || state.kind === "dragging-handle";
}

export function reduceSelectionGesture(
  context: SelectionGestureContext,
  state: SelectionGestureState,
  selection: DiffSelection | null,
  event: SelectionGestureEvent,
): SelectionGestureResult {
  switch (event.type) {
    case "touch-start":
    case "touch-move":
    case "touch-end":
    case "touch-cancel":
      return reduceTouch(state, selection, event);
    case "long-press":
      return reduceLongPress(context, state, selection, event.point);
    case "handle-start":
      return reduceHandleStart(state, selection, event.handle);
    case "drag":
      return reduceDrag(context, state, selection, event.point);
    case "drag-end": {
      const ends =
        (event.source === "long-press" && state.kind === "selecting") ||
        (event.source === "handle" && state.kind === "dragging-handle");
      return { state: ends ? IDLE_SELECTION_GESTURE : state, selection, effect: "none" };
    }
  }
}

type TouchEvent = Extract<SelectionGestureEvent, { type: `touch-${string}` }>;

function reduceTouch(
  state: SelectionGestureState,
  selection: DiffSelection | null,
  event: TouchEvent,
): SelectionGestureResult {
  const result = (next: SelectionGestureState, effect: SelectionGestureEffect = "none") => ({
    state: next,
    selection: effect === "dismiss" ? null : selection,
    effect,
  });
  if (event.type === "touch-start") {
    // A second finger never interrupts a running drag.
    if (isSelectionDragActive(state)) return result(state);
    return result({
      kind: "pressing",
      x: event.pageX,
      y: event.pageY,
      startedAt: event.time,
      moved: false,
    });
  }
  if (state.kind !== "pressing") return result(state);
  if (event.type === "touch-move") {
    const distance = Math.hypot(event.pageX - state.x, event.pageY - state.y);
    return result(distance > SELECTION_TAP_MAX_DISTANCE ? { ...state, moved: true } : state);
  }
  if (event.type === "touch-cancel") return result(IDLE_SELECTION_GESTURE);
  const isTap = !state.moved && event.time - state.startedAt <= SELECTION_TAP_MAX_DURATION_MS;
  if (!isTap) return result(IDLE_SELECTION_GESTURE);
  // Like web, a tap only dismisses an existing selection; it never also comments.
  return result(IDLE_SELECTION_GESTURE, selection ? "dismiss" : "comment");
}

function reduceLongPress(
  context: SelectionGestureContext,
  state: SelectionGestureState,
  selection: DiffSelection | null,
  point: SelectionGesturePoint,
): SelectionGestureResult {
  if (state.kind === "dragging-handle") return { state, selection, effect: "none" };
  const position = positionAt(context, point);
  // A press outside line rows (header, review gap) selects nothing.
  if (!position) return { state: IDLE_SELECTION_GESTURE, selection, effect: "none" };
  const origin = selectCellSource(context.model, position);
  return {
    state: { kind: "selecting", origin, lockCellIndex: position.cellIndex },
    selection: origin,
    effect: "none",
  };
}

function reduceHandleStart(
  state: SelectionGestureState,
  selection: DiffSelection | null,
  handle: SelectionHandle,
): SelectionGestureResult {
  if (!selection || state.kind === "selecting") return { state, selection, effect: "none" };
  const { start, end } = orderedSelection(selection);
  const anchor = handle === "start" ? end : start;
  return {
    state: { kind: "dragging-handle", anchor, lockCellIndex: anchor.cellIndex },
    selection: { anchor, focus: handle === "start" ? start : end },
    effect: "none",
  };
}

function reduceDrag(
  context: SelectionGestureContext,
  state: SelectionGestureState,
  selection: DiffSelection | null,
  point: SelectionGesturePoint,
): SelectionGestureResult {
  const unchanged = { state, selection, effect: "none" } as const;
  if (state.kind !== "selecting" && state.kind !== "dragging-handle") return unchanged;
  // Above or below a file's lines (its header, padding or border) the drag
  // clamps to the nearest line edge, so an auto-scroll that stops at the top
  // still reaches the first line. Other misses (a later hunk header, a missing
  // cell on the locked side, a review gap) hold the last focus.
  const focus =
    positionAt(context, point, state.lockCellIndex) ??
    nativeSelectionEdgePosition({
      model: context.model,
      file: point.file,
      locationY: point.locationY,
      lockCellIndex: state.lockCellIndex,
    });
  if (!focus) return unchanged;
  let anchor = state.kind === "dragging-handle" ? state.anchor : null;
  if (state.kind === "selecting") {
    // Grow from the pressed cell: its end anchors an upward drag, its start a downward one.
    const { start, end } = orderedSelection(state.origin);
    if (comparePosition(focus, start) >= 0 && comparePosition(focus, end) <= 0) {
      return { state, selection: state.origin, effect: "none" };
    }
    anchor = comparePosition(focus, start) < 0 ? end : start;
  }
  if (!anchor) return unchanged;
  return {
    state,
    selection: extendNativeSelection(context.model, { anchor, focus: anchor }, focus),
    effect: "none",
  };
}

function positionAt(
  context: SelectionGestureContext,
  point: SelectionGesturePoint,
  lockCellIndex?: number,
): DiffCharacterPosition | null {
  return nativeSelectionPositionAtBodyPoint({
    model: context.model,
    file: point.file,
    locationX: point.locationX,
    locationY: point.locationY,
    horizontalOffsets: context.horizontalOffsets,
    lockCellIndex,
  });
}
