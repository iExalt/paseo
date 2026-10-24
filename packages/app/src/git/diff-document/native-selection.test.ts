import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { selectAllSource } from "./hit-testing";
import { buildDiffDocumentModel } from "./model";
import { buildNativeCanvasSlabs } from "./native-slabs";
import {
  EMPTY_SLAB_SELECTION_RECTS,
  buildNativeSelectionGeometry,
  extendNativeSelection,
  nativeCaretViewportX,
  nativeSelectedText,
  nativeSelectionCarets,
  nativeSelectionPositionAtBodyPoint,
  nativeSelectionRectsForSlab,
  selectionForScope,
  type NativeDiffSelectionScope,
} from "./native-selection";
import type {
  BuildDiffDocumentModelInput,
  DiffCharacterPosition,
  DiffDocumentModel,
  DiffLineRow,
} from "./types";

// Every grapheme is 10px wide; the code column starts at gutterWidth + 8.
const measurer = { measure: (text: string) => Array.from(text).length * 10 };
const LINE_HEIGHT = 18;

describe("native diff selection", () => {
  it("maps body points to anchor and focus and copies unified source including deletions", () => {
    const model = build({ layout: "unified" });
    const file = model.files[0]!;
    const removed = lineRow(model, (row) => row.cells[0]?.content === "old-one");
    const added = lineRow(model, (row) => row.cells[0]?.content === "new-two");
    const anchor = pointAt(model, removed, file.gutterWidth + 8 + 40, {});
    const focus = pointAt(model, added, file.gutterWidth + 8 + 30, {});
    expect(anchor?.sourceOffset).toBe(4);
    expect(focus?.sourceOffset).toBe(3);

    const text = nativeSelectedText(model, { anchor: anchor!, focus: focus! });
    expect(text).toBe("one\nold-two\nnew-one\nnew");
    expect(text).not.toMatch(/^\d/m);
    expect(nativeSelectedText(model, null)).toBe("");
  });

  it("locks a split selection to the anchor side and copies only that side", () => {
    const model = build({ layout: "split" });
    const file = model.files[0]!;
    const columnWidth = model.viewportWidth / 2;
    const first = lineRow(model, (row) => row.cells[0]?.content === "old-one");
    const second = lineRow(model, (row) => row.cells[0]?.content === "old-two");
    const rightX = columnWidth + file.gutterWidth + 8 + 20;

    const leftAnchor = pointAt(model, first, file.gutterWidth + 8 + 40, {})!;
    expect(leftAnchor.cellIndex).toBe(0);
    // Dragging into the right pane clamps to the left pane's last visible character.
    const lockedLeft = pointAt(model, second, rightX, {}, leftAnchor.cellIndex)!;
    expect(lockedLeft.cellIndex).toBe(0);
    const left = extendNativeSelection(
      model,
      { anchor: leftAnchor, focus: leftAnchor },
      lockedLeft,
    );
    expect(nativeSelectedText(model, left)).toBe("one\nold-two");

    const rightAnchor = pointAt(model, first, rightX, {})!;
    expect(rightAnchor.cellIndex).toBe(1);
    const lockedRight = pointAt(model, second, 0, {}, rightAnchor.cellIndex)!;
    expect(lockedRight).toMatchObject({ cellIndex: 1, sourceOffset: 0 });
    // An unlocked focus on the other side never moves a split selection.
    const crossing = { ...lockedLeft };
    expect(
      extendNativeSelection(model, { anchor: rightAnchor, focus: rightAnchor }, crossing),
    ).toEqual({ anchor: rightAnchor, focus: rightAnchor });
    expect(
      nativeSelectedText(model, {
        anchor: rightAnchor,
        focus: { ...lockedRight, sourceOffset: 7 },
      }),
    ).toBe("w-one\nnew-two");
  });

  it("returns null for a locked side without a cell so the drag keeps its focus", () => {
    const model = build({ layout: "split", files: [deletedFile()] });
    const file = model.files[0]!;
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "gone");
    expect(row.cells[1]).toBeNull();
    expect(pointAt(model, row, model.viewportWidth - 10, {}, 1)).toBeNull();
    expect(pointAt(model, row, file.gutterWidth + 9, {}, 0)?.cellIndex).toBe(0);
  });

  it("applies the horizontal offset of the file under the point, but never in wrapped mode", () => {
    const scrolled = build({
      wrapLines: false,
      files: [diffFile("src/a.ts"), diffFile("src/b.ts")],
    });
    const first = scrolled.files[0]!;
    const second = scrolled.files[1]!;
    const row = lineRow(scrolled, (r) => r.fileIndex === 1 && r.cells[0]?.content === "old-one");
    const offsets = { "src/a.ts": 0, "src/b.ts": 30 };
    // The touch starts in the first file's body but lands on the second file.
    const position = nativeSelectionPositionAtBodyPoint({
      model: scrolled,
      file: first,
      locationX: second.gutterWidth + 8 + 10,
      locationY: row.top - first.bodyTop + 2,
      horizontalOffsets: offsets,
    });
    expect(position).toMatchObject({ fileIndex: 1, sourceOffset: 4 });

    const wrapped = build({ wrapLines: true });
    const wrappedRow = lineRow(wrapped, (r) => r.cells[0]?.content === "old-one");
    expect(
      pointAt(wrapped, wrappedRow, wrapped.files[0]!.gutterWidth + 8 + 10, { "src/a.ts": 30 })
        ?.sourceOffset,
    ).toBe(1);
  });

  it("places highlights in each column's code-picture space", () => {
    const model = build({ layout: "split" });
    const file = model.files[0]!;
    const columnWidth = model.viewportWidth / 2;
    const first = lineRow(model, (row) => row.cells[1]?.content === "new-one");
    const second = lineRow(model, (row) => row.cells[1]?.content === "new-two");
    const selection = {
      anchor: positionIn(first, 1, 2),
      focus: positionIn(second, 1, 5),
    };
    const slab = buildNativeCanvasSlabs(model, 800)[0]!;
    const rects = nativeSelectionRectsForSlab(buildNativeSelectionGeometry(model, selection), slab);
    expect(rects.unified).toEqual([]);
    expect(rects.left).toEqual([]);
    const textX = columnWidth + file.gutterWidth + 8;
    expect(rects.right).toEqual([
      { x: textX + 20, y: first.top - slab.top, width: 50, height: LINE_HEIGHT },
      { x: textX, y: second.top - slab.top, width: 50, height: LINE_HEIGHT },
    ]);
  });

  it("highlights every wrapped fragment of a selected line", () => {
    const model = build({ wrapLines: true, viewportWidth: 140, files: [longFile()] });
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "abcdefghijkl");
    expect(row.cells[0]!.fragments.length).toBeGreaterThan(1);
    const selection = { anchor: positionIn(row, 0, 1), focus: positionIn(row, 0, 11) };
    const slab = buildNativeCanvasSlabs(model, 800)[0]!;
    const rects = nativeSelectionRectsForSlab(buildNativeSelectionGeometry(model, selection), slab);
    expect(rects.unified.map((rect) => rect.y)).toEqual(
      row.cells[0]!.fragments.map((fragment) => row.top - slab.top + fragment.top),
    );
    expect(rects.unified.reduce((width, rect) => width + rect.width, 0)).toBe(100);
  });

  it("splits a multi-slab selection across slabs in slab-local coordinates", () => {
    const model = build({ wrapLines: false, files: [manyLinesFile(80)] });
    const slabs = buildNativeCanvasSlabs(model, 0);
    expect(slabs.length).toBeGreaterThan(1);
    const all = selectAllSource(model)!;
    const geometry = buildNativeSelectionGeometry(model, all);
    const perSlab = slabs.map((slab) => nativeSelectionRectsForSlab(geometry, slab).unified);
    expect(perSlab.every((rects) => rects.length > 0)).toBe(true);
    for (const [index, rects] of perSlab.entries()) {
      const slab = slabs[index]!;
      for (const rect of rects) {
        expect(rect.y + rect.height).toBeGreaterThan(0);
        expect(rect.y).toBeLessThan(slab.height);
      }
    }
    // A row straddling a boundary is drawn by both slabs; every row is drawn at least once.
    const drawnRows = new Set<number>();
    for (const [index, rects] of perSlab.entries()) {
      for (const rect of rects) drawnRows.add(rect.y + slabs[index]!.top);
    }
    expect(drawnRows.size).toBe(geometry!.length);
  });

  it("costs nothing without a selection", () => {
    const model = build({});
    const slab = buildNativeCanvasSlabs(model, 800)[0]!;
    expect(buildNativeSelectionGeometry(model, null)).toBeNull();
    expect(nativeSelectionRectsForSlab(null, slab)).toBe(EMPTY_SLAB_SELECTION_RECTS);
    expect(nativeSelectionCarets(model, null)).toBeNull();
  });

  it("anchors handles at the ordered start and end with wrap affinity and scroll offset", () => {
    const model = build({ wrapLines: true, viewportWidth: 140, files: [longFile()] });
    const file = model.files[0]!;
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "abcdefghijkl");
    const [firstFragment, secondFragment] = row.cells[0]!.fragments;
    const boundary = firstFragment!.end;
    const textX = file.gutterWidth + 8;
    // Backward selection whose two ends sit on the same wrap boundary.
    const carets = nativeSelectionCarets(model, {
      anchor: positionIn(row, 0, boundary),
      focus: positionIn(row, 0, boundary),
    })!;
    expect(carets.start).toMatchObject({ x: textX, top: row.top + secondFragment!.top });
    expect(carets.end).toMatchObject({
      x: textX + firstFragment!.width,
      top: row.top + firstFragment!.top,
      height: LINE_HEIGHT,
      scrollsHorizontally: false,
    });
    expect(nativeCaretViewportX(carets.end, { [file.path]: 40 })).toBe(carets.end.x);

    const scrolled = build({ wrapLines: false });
    const scrolledRow = lineRow(scrolled, (r) => r.cells[0]?.content === "old-one");
    const end = nativeSelectionCarets(scrolled, {
      anchor: positionIn(scrolledRow, 0, 5),
      focus: positionIn(scrolledRow, 0, 2),
    })!;
    expect(end.start.x).toBe(scrolled.files[0]!.gutterWidth + 8 + 20);
    expect(nativeCaretViewportX(end.end, { "src/a.ts": 30 })).toBe(end.end.x - 30);
  });

  it("drops a selection when files, layout, collapse state or typography change", () => {
    const model = build({});
    const row = lineRow(model, (candidate) => candidate.cells[0]?.content === "old-one");
    const selection = { anchor: positionIn(row, 0, 0), focus: positionIn(row, 0, 3) };
    const scope: NativeDiffSelectionScope = {
      files: [],
      layout: "unified",
      collapsedFilePaths: new Set(),
      typography: { family: "monospace", size: 12, lineHeight: LINE_HEIGHT },
    };
    expect(selectionForScope({ scope, selection }, { ...scope })).toBe(selection);
    expect(selectionForScope({ scope, selection }, { ...scope, files: [] })).toBeNull();
    expect(selectionForScope({ scope, selection }, { ...scope, layout: "split" })).toBeNull();
    expect(
      selectionForScope({ scope, selection }, { ...scope, collapsedFilePaths: new Set() }),
    ).toBeNull();
    expect(
      selectionForScope({ scope, selection }, { ...scope, typography: { ...scope.typography } }),
    ).toBeNull();
    expect(selectionForScope(null, scope)).toBeNull();
  });
});

function pointAt(
  model: DiffDocumentModel,
  row: DiffLineRow,
  locationX: number,
  horizontalOffsets: Record<string, number>,
  lockCellIndex?: number,
): DiffCharacterPosition | null {
  const file = model.files[row.fileIndex]!;
  return nativeSelectionPositionAtBodyPoint({
    model,
    file,
    locationX,
    locationY: row.top - file.bodyTop + 2,
    horizontalOffsets,
    lockCellIndex,
  });
}

function positionIn(
  row: DiffLineRow,
  cellIndex: number,
  sourceOffset: number,
): DiffCharacterPosition {
  const cell = row.cells[cellIndex]!;
  return {
    fileIndex: row.fileIndex,
    rowIndex: row.index,
    cellIndex,
    side: cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new"),
    sourceOffset,
  };
}

function lineRow(model: DiffDocumentModel, predicate: (row: DiffLineRow) => boolean): DiffLineRow {
  const row = model.rows.find(
    (candidate): candidate is DiffLineRow => candidate.kind === "line" && predicate(candidate),
  );
  if (!row) throw new Error("Expected a matching line row");
  return row;
}

function build(overrides: Partial<BuildDiffDocumentModelInput>): DiffDocumentModel {
  return buildDiffDocumentModel({
    files: [diffFile("src/a.ts")],
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: false,
    viewportWidth: 400,
    typography: { family: "monospace", size: 12, lineHeight: LINE_HEIGHT },
    measureText: measurer,
    palette: {
      surface: "#000",
      headerSurface: "#111",
      border: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      addition: "green",
      deletion: "red",
      additionBackground: "#010",
      deletionBackground: "#100",
      emptyBackground: "#111",
      selection: "blue",
      headerActiveSurface: "#222",
      headerBorder: "#333",
      statusSuccess: "green",
      statusDanger: "red",
      statusWarning: "orange",
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  });
}

function diffFile(path: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,2 +1,2 @@" },
          { type: "remove", content: "old-one" },
          { type: "remove", content: "old-two" },
          { type: "add", content: "new-one" },
          { type: "add", content: "new-two" },
        ],
      },
    ],
  };
}

function deletedFile(): ParsedDiffFile {
  return {
    path: "src/deleted.ts",
    isNew: false,
    isDeleted: true,
    additions: 0,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 0,
        newCount: 0,
        lines: [
          { type: "header", content: "@@ -1,1 +0,0 @@" },
          { type: "remove", content: "gone" },
        ],
      },
    ],
  };
}

function longFile(): ParsedDiffFile {
  return {
    path: "src/long.ts",
    isNew: true,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [
          { type: "header", content: "@@ -0,0 +1,1 @@" },
          { type: "add", content: "abcdefghijkl" },
        ],
      },
    ],
  };
}

function manyLinesFile(count: number): ParsedDiffFile {
  return {
    path: "src/many.ts",
    isNew: true,
    isDeleted: false,
    additions: count,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: count,
        lines: [
          { type: "header", content: `@@ -0,0 +1,${count} @@` },
          ...Array.from({ length: count }, (_, index) => ({
            type: "add" as const,
            content: `line-${index}`,
          })),
        ],
      },
    ],
  };
}
