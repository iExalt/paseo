import { describe, expect, it } from "vitest";
import { nativeSelectedText } from "./native-selection";
import { build, lineRow, positionIn } from "./native-selection-fixture";
import {
  IDLE_SELECTION_GESTURE,
  isSelectionDragActive,
  reduceSelectionGesture,
  type SelectionGestureEvent,
  type SelectionGesturePoint,
  type SelectionGestureResult,
  type SelectionGestureState,
} from "./selection-gesture";
import type { DiffDocumentModel, DiffLineRow, DiffSelection } from "./types";

describe("native diff selection gesture", () => {
  it("opens a comment on a quick tap without a selection", () => {
    const model = build({});
    const result = run(model, null, [
      { type: "touch-start", pageX: 50, pageY: 50, time: 0 },
      { type: "touch-move", pageX: 55, pageY: 54 },
      { type: "touch-end", time: 300 },
    ]);
    expect(result).toEqual({ state: IDLE_SELECTION_GESTURE, selection: null, effect: "comment" });
  });

  it("dismisses an existing selection on a tap without opening a comment", () => {
    const model = build({});
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "old-one");
    const selection = { anchor: positionIn(row, 0, 0), focus: positionIn(row, 0, 3) };
    const result = run(model, selection, [
      { type: "touch-start", pageX: 50, pageY: 50, time: 0 },
      { type: "touch-end", time: 100 },
    ]);
    expect(result).toEqual({ state: IDLE_SELECTION_GESTURE, selection: null, effect: "dismiss" });
  });

  it("keeps the selection and does nothing when the touch scrolls or is held too long", () => {
    const model = build({});
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "old-one");
    const selection = { anchor: positionIn(row, 0, 0), focus: positionIn(row, 0, 3) };
    const scrolled = run(model, selection, [
      { type: "touch-start", pageX: 50, pageY: 50, time: 0 },
      { type: "touch-move", pageX: 50, pageY: 80 },
      { type: "touch-move", pageX: 50, pageY: 50 },
      { type: "touch-end", time: 100 },
    ]);
    expect(scrolled).toEqual({ state: IDLE_SELECTION_GESTURE, selection, effect: "none" });
    const held = run(model, null, [
      { type: "touch-start", pageX: 50, pageY: 50, time: 0 },
      { type: "touch-end", time: 501 },
    ]);
    expect(held.effect).toBe("none");
    const cancelled = run(model, null, [
      { type: "touch-start", pageX: 50, pageY: 50, time: 0 },
      { type: "touch-cancel" },
      { type: "touch-end", time: 100 },
    ]);
    expect(cancelled.effect).toBe("none");
  });

  it("selects the pressed line and grows the drag from whichever end it leaves", () => {
    const model = build({});
    const removed = lineRow(model, (row) => row.cells[0]?.content === "old-two");
    const added = lineRow(model, (row) => row.cells[0]?.content === "new-one");
    const above = lineRow(model, (row) => row.cells[0]?.content === "old-one");
    const x = textX(model, 0) + 30;
    const pressed = run(model, null, [
      { type: "touch-start", pageX: 0, pageY: 0, time: 0 },
      { type: "long-press", point: pointOn(model, removed, x) },
      // The responder sees a cancel once the long-press claims the touch.
      { type: "touch-cancel" },
    ]);
    expect(pressed.state.kind).toBe("selecting");
    expect(isSelectionDragActive(pressed.state)).toBe(true);
    expect(text(model, pressed.selection)).toBe("old-two");

    const down = step(model, pressed, { type: "drag", point: pointOn(model, added, x) });
    expect(text(model, down.selection)).toBe("old-two\nnew");
    const up = step(model, down, { type: "drag", point: pointOn(model, above, x) });
    expect(text(model, up.selection)).toBe("-one\nold-two");
    const back = step(model, up, { type: "drag", point: pointOn(model, removed, 10) });
    expect(back.selection).toEqual(pressed.selection);

    // Only the long-press's own end finishes it; the selection stays for the handles.
    expect(step(model, back, { type: "drag-end", source: "handle" }).state).toBe(back.state);
    const ended = step(model, back, { type: "drag-end", source: "long-press" });
    expect(ended).toEqual({
      state: IDLE_SELECTION_GESTURE,
      selection: back.selection,
      effect: "none",
    });
  });

  it("holds the last focus over headers, hunk headers and the other split side", () => {
    const model = build({ layout: "split" });
    const file = model.files[0]!;
    const first = lineRow(model, (row) => row.cells[1]?.content === "new-one");
    const second = lineRow(model, (row) => row.cells[1]?.content === "new-two");
    const hunkHeader = lineRow(model, (row) => row.cells[0]?.type === "header");
    const rightX = textX(model, 1) + 20;
    const pressed = run(model, null, [
      { type: "long-press", point: pointOn(model, first, rightX) },
    ]);
    expect(pressed.state).toMatchObject({ kind: "selecting", lockCellIndex: 1 });
    const dragged = step(model, pressed, { type: "drag", point: pointOn(model, second, rightX) });
    expect(text(model, dragged.selection)).toBe("new-one\nne");

    // Into the left column: clamped to the right side's first character.
    const crossed = step(model, dragged, { type: "drag", point: pointOn(model, second, 5) });
    expect(crossed.selection?.focus).toMatchObject({ cellIndex: 1, sourceOffset: 0 });
    for (const point of [
      pointOn(model, hunkHeader, rightX),
      { file, locationX: rightX, locationY: -4 },
      { file, locationX: rightX, locationY: model.height + 100 },
    ]) {
      expect(step(model, crossed, { type: "drag", point })).toEqual(crossed);
    }
  });

  it("ignores a long-press outside line rows", () => {
    const model = build({});
    const file = model.files[0]!;
    const result = run(model, null, [
      { type: "long-press", point: { file, locationX: 50, locationY: -4 } },
    ]);
    expect(result).toEqual({ state: IDLE_SELECTION_GESTURE, selection: null, effect: "none" });
  });

  it("moves one end with a handle while the other end anchors it", () => {
    const model = build({ layout: "split" });
    const first = lineRow(model, (row) => row.cells[0]?.content === "old-one");
    const second = lineRow(model, (row) => row.cells[0]?.content === "old-two");
    const selection = { anchor: positionIn(second, 0, 4), focus: positionIn(first, 0, 2) };
    const grabbed = run(model, selection, [{ type: "handle-start", handle: "start" }]);
    expect(grabbed.state).toMatchObject({
      kind: "dragging-handle",
      anchor: selection.anchor,
      lockCellIndex: 0,
    });
    expect(text(model, grabbed.selection)).toBe("d-one\nold-");

    const moved = step(model, grabbed, {
      type: "drag",
      point: pointOn(model, first, textX(model, 0) + 50),
    });
    expect(text(model, moved.selection)).toBe("ne\nold-");
    // Past the anchor the handle keeps its side and the selection flips direction.
    const flipped = step(model, moved, {
      type: "drag",
      point: pointOn(model, second, model.viewportWidth - 5),
    });
    expect(text(model, flipped.selection)).toBe("two");
    expect(flipped.selection?.anchor).toEqual(selection.anchor);
    expect(step(model, flipped, { type: "touch-start", pageX: 0, pageY: 0, time: 0 }).state).toBe(
      flipped.state,
    );
    expect(step(model, flipped, { type: "drag-end", source: "handle" }).state).toBe(
      IDLE_SELECTION_GESTURE,
    );
    expect(run(model, null, [{ type: "handle-start", handle: "end" }]).state).toBe(
      IDLE_SELECTION_GESTURE,
    );
  });
});

function run(
  model: DiffDocumentModel,
  selection: DiffSelection | null,
  events: SelectionGestureEvent[],
  state: SelectionGestureState = IDLE_SELECTION_GESTURE,
): SelectionGestureResult {
  let result: SelectionGestureResult = { state, selection, effect: "none" };
  for (const event of events) result = step(model, result, event);
  return result;
}

function step(
  model: DiffDocumentModel,
  previous: SelectionGestureResult,
  event: SelectionGestureEvent,
): SelectionGestureResult {
  return reduceSelectionGesture(
    { model, horizontalOffsets: {} },
    previous.state,
    previous.selection,
    event,
  );
}

function textX(model: DiffDocumentModel, cellIndex: number): number {
  const file = model.files[0]!;
  return cellIndex * (model.viewportWidth / 2) + file.gutterWidth + 8;
}

function pointOn(
  model: DiffDocumentModel,
  row: DiffLineRow,
  locationX: number,
): SelectionGesturePoint {
  const file = model.files[row.fileIndex]!;
  return { file, locationX, locationY: row.top - file.bodyTop + 2 };
}

function text(model: DiffDocumentModel, selection: DiffSelection | null): string {
  return nativeSelectedText(model, selection);
}
