import { describe, expect, it } from "vitest";
import { nativeSelectedText } from "./native-selection";
import { build, diffFile, lineRow } from "./native-selection-fixture";
import {
  SELECTION_AUTO_SCROLL_EDGE,
  SELECTION_AUTO_SCROLL_MAX_STEP,
  handleDragPointer,
  longPressDragPointer,
  nextSelectionAutoScrollTop,
  selectionAutoScrollStep,
  selectionDragPoint,
  selectionDragViewportY,
  type SelectionDragPointer,
} from "./selection-auto-scroll";
import { IDLE_SELECTION_GESTURE, reduceSelectionGesture } from "./selection-gesture";

const FRAME_MS = 1000 / 60;

describe("selection auto-scroll", () => {
  it("speeds up with depth into either edge zone and caps at the edge", () => {
    const height = 600;
    const edge = SELECTION_AUTO_SCROLL_EDGE;
    const max = SELECTION_AUTO_SCROLL_MAX_STEP;
    expect(selectionAutoScrollStep(edge, height)).toBe(0);
    expect(selectionAutoScrollStep(height / 2, height)).toBe(0);
    expect(selectionAutoScrollStep(height - edge, height)).toBe(0);
    expect(selectionAutoScrollStep(edge / 2, height)).toBeCloseTo(-max / 2);
    expect(selectionAutoScrollStep(height - edge / 4, height)).toBeCloseTo((max * 3) / 4);
    // At or past an edge (the finger left the viewport) it stays at top speed.
    expect(selectionAutoScrollStep(0, height)).toBe(-max);
    expect(selectionAutoScrollStep(-200, height)).toBe(-max);
    expect(selectionAutoScrollStep(height + 200, height)).toBe(max);
    // A short viewport shrinks the zones so its middle never scrolls.
    expect(selectionAutoScrollStep(100, 200)).toBe(0);
    expect(selectionAutoScrollStep(0, 0)).toBe(0);
  });

  it("scales the step by frame time and stops at either end of the content", () => {
    const base = { viewportHeight: 600, maxScrollTop: 1000, elapsedMs: FRAME_MS };
    const max = SELECTION_AUTO_SCROLL_MAX_STEP;
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: 300, scrollTop: 500 })).toBeNull();
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: 700, scrollTop: 500 })).toBeCloseTo(
      500 + max,
    );
    expect(
      nextSelectionAutoScrollTop({
        ...base,
        viewportY: 700,
        scrollTop: 500,
        elapsedMs: FRAME_MS / 2,
      }),
    ).toBeCloseTo(500 + max / 2);
    // A long stall doesn't jump the list.
    expect(
      nextSelectionAutoScrollTop({ ...base, viewportY: 700, scrollTop: 500, elapsedMs: 2000 }),
    ).toBeCloseTo(500 + max * 3);
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: 700, scrollTop: 995 })).toBe(1000);
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: 700, scrollTop: 1000 })).toBeNull();
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: -5, scrollTop: 5 })).toBe(0);
    expect(nextSelectionAutoScrollTop({ ...base, viewportY: -5, scrollTop: 0 })).toBeNull();
  });

  it("maps a still long-press finger to the row the scroll brings under it", () => {
    const model = build({ files: [diffFile("src/a.ts"), diffFile("src/b.ts")] });
    const file = model.files[0]!;
    const first = lineRow(
      model,
      (row) => row.fileIndex === 0 && row.cells[0]?.content === "old-one",
    );
    const below = lineRow(
      model,
      (row) => row.fileIndex === 0 && row.cells[0]?.content === "new-one",
    );
    const x = file.gutterWidth + 8 + 30;
    const scrollTop = 10;
    // The gesture reports body coordinates; the body sits at bodyTop - scrollTop in the viewport.
    const bodyY = first.top - file.bodyTop + 2;
    const pointer = longPressDragPointer({ model, fileIndex: 0, bodyX: x, bodyY, scrollTop })!;
    expect(selectionDragViewportY(pointer)).toBe(first.top + 2 - scrollTop);
    expect(selectionDragPoint(model, pointer, scrollTop)).toEqual({
      file,
      locationX: x,
      locationY: bodyY,
    });

    // The list scrolls down two rows while the finger stays put.
    const scrolled = scrollTop + (below.top - first.top);
    const point = selectionDragPoint(model, pointer, scrolled)!;
    expect(point.locationY).toBe(below.top - file.bodyTop + 2);
    const pressed = reduceSelectionGesture(
      { model, horizontalOffsets: {} },
      IDLE_SELECTION_GESTURE,
      null,
      { type: "long-press", point: selectionDragPoint(model, pointer, scrollTop)! },
    );
    const extended = reduceSelectionGesture(
      { model, horizontalOffsets: {} },
      pressed.state,
      pressed.selection,
      { type: "drag", point },
    );
    expect(nativeSelectedText(model, extended.selection)).toBe("old-one\nold-two\nnew");
  });

  it("adds the scroll since a handle drag began to its translation", () => {
    const model = build({ files: [diffFile("src/a.ts"), diffFile("src/b.ts")] });
    const file = model.files[0]!;
    const pointer: SelectionDragPointer = {
      ...handleDragPointer({ fileIndex: 0, caretViewportX: 90, caretMiddleY: 100, scrollTop: 40 }),
      deltaX: 5,
      deltaY: 30,
    };
    expect(selectionDragViewportY(pointer)).toBe(100 - 40 + 30);
    expect(selectionDragPoint(model, pointer, 40)).toEqual({
      file,
      locationX: 95,
      locationY: 100 + 30 - file.bodyTop,
    });
    expect(selectionDragPoint(model, pointer, 140)?.locationY).toBe(100 + 30 + 100 - file.bodyTop);
    expect(selectionDragPoint(model, { ...pointer, fileIndex: 9 }, 40)).toBeNull();
  });
});
