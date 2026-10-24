import { orderedSelection, selectedSourceText, selectionRectangles } from "./hit-testing";
import { horizontalOffsetForPath, type DiffHorizontalOffsets } from "./horizontal-offsets";
import { fileAtDocumentOffset, fragmentWidthForRange } from "./model";
import { hitTestDiffBodyPoint } from "./native-hit-testing";
import type {
  DiffCharacterPosition,
  DiffDocumentModel,
  DiffFileSection,
  DiffSelection,
  DiffSurfaceProps,
  DiffTypography,
} from "./types";

// Native wrappers over the platform-neutral hit-testing selection model. They
// translate between the native surface's coordinate spaces (file-body touch
// points, slab-local Skia pictures) and the document space hit-testing uses.

const CODE_LEFT_PADDING = 8;
/** Keeps a side-locked x strictly inside its split column. */
const COLUMN_EDGE_INSET = 0.01;

export type NativeSelectionColumn = "unified" | "left" | "right";

/**
 * A highlight rectangle in a slab's code-picture space: x is the unscrolled
 * document x (the code pictures are recorded without horizontal offset), y is
 * relative to the slab top. Draw it under the same transform and clip as the
 * column's code picture.
 */
export interface NativeSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NativeSlabSelectionRects = Readonly<
  Record<NativeSelectionColumn, readonly NativeSelectionRect[]>
>;

/** One selection rectangle in document space, tagged with the picture column that draws it. */
export interface NativeSelectionGeometryRect extends NativeSelectionRect {
  fileIndex: number;
  column: NativeSelectionColumn;
}

export type NativeSelectionGeometry = readonly NativeSelectionGeometryRect[];

/**
 * A caret for a selection handle, in document space. `x` is unscrolled; use
 * `nativeCaretViewportX` to apply the file's horizontal offset.
 */
export interface NativeSelectionCaret {
  fileIndex: number;
  path: string;
  x: number;
  top: number;
  height: number;
  /** The code column's clip; a caret outside it is scrolled out of view. */
  clipX: number;
  clipWidth: number;
  scrollsHorizontally: boolean;
}

const EMPTY_RECTS: readonly NativeSelectionRect[] = [];
export const EMPTY_SLAB_SELECTION_RECTS: NativeSlabSelectionRects = {
  unified: EMPTY_RECTS,
  left: EMPTY_RECTS,
  right: EMPTY_RECTS,
};

/**
 * Resolves a touch in `file`'s body coordinates to a character position. The
 * point may fall outside `file` (drags cross files); the horizontal offset of
 * whichever file is under the point is used. With `lockCellIndex` in split
 * layout the point is clamped into that column, and a row without a cell on
 * that side yields null so the caller can keep its previous focus.
 */
export function nativeSelectionPositionAtBodyPoint(input: {
  model: DiffDocumentModel;
  file: DiffFileSection;
  locationX: number;
  locationY: number;
  horizontalOffsets: Readonly<DiffHorizontalOffsets>;
  lockCellIndex?: number;
}): DiffCharacterPosition | null {
  const { model } = input;
  const documentY = input.file.bodyTop + input.locationY;
  const targetFile = fileAtDocumentOffset(model.files, documentY);
  if (!targetFile) return null;
  const horizontalOffset = model.wrapLines
    ? 0
    : horizontalOffsetForPath(input.horizontalOffsets, targetFile.path);
  const lock = model.layout === "split" ? input.lockCellIndex : undefined;
  let locationX = input.locationX;
  if (lock !== undefined) {
    const columnWidth = model.viewportWidth / 2;
    locationX = Math.min(
      Math.max(locationX, lock * columnWidth),
      (lock + 1) * columnWidth - COLUMN_EDGE_INSET,
    );
  }
  const hit = hitTestDiffBodyPoint({
    model,
    file: input.file,
    locationX,
    locationY: input.locationY,
    horizontalOffset,
  });
  if (hit?.kind !== "cell") return null;
  if (lock !== undefined && hit.position.cellIndex !== lock) return null;
  return hit.position;
}

/** Moves the focus of a drag, keeping a split selection on the anchor's side. */
export function extendNativeSelection(
  model: DiffDocumentModel,
  selection: DiffSelection,
  focus: DiffCharacterPosition | null,
): DiffSelection {
  if (!focus) return selection;
  if (model.layout === "split" && focus.cellIndex !== selection.anchor.cellIndex) return selection;
  return { anchor: selection.anchor, focus };
}

/** Computes every highlight rectangle once per selection; slabs then filter it. */
export function buildNativeSelectionGeometry(
  model: DiffDocumentModel,
  selection: DiffSelection | null,
): NativeSelectionGeometry | null {
  if (!selection) return null;
  const geometry: NativeSelectionGeometryRect[] = [];
  for (const rectangle of selectionRectangles({ model, selection })) {
    const row = model.rows[rectangle.rowIndex];
    if (!row || row.kind !== "line") continue;
    geometry.push({
      fileIndex: rectangle.fileIndex,
      column: pictureColumn(row.cells.length, rectangle.cellIndex),
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    });
  }
  return geometry;
}

/** Converts document-space geometry into one slab's picture space, by column. */
export function nativeSelectionRectsForSlab(
  geometry: NativeSelectionGeometry | null,
  slab: { fileIndex: number; top: number; height: number },
): NativeSlabSelectionRects {
  if (!geometry || geometry.length === 0) return EMPTY_SLAB_SELECTION_RECTS;
  const bottom = slab.top + slab.height;
  let rects: Record<NativeSelectionColumn, NativeSelectionRect[]> | null = null;
  for (const rectangle of geometry) {
    if (rectangle.fileIndex !== slab.fileIndex) continue;
    if (rectangle.y >= bottom || rectangle.y + rectangle.height <= slab.top) continue;
    rects ??= { unified: [], left: [], right: [] };
    rects[rectangle.column].push({
      x: rectangle.x,
      y: rectangle.y - slab.top,
      width: rectangle.width,
      height: rectangle.height,
    });
  }
  return rects ?? EMPTY_SLAB_SELECTION_RECTS;
}

/** Start and end carets for selection handles, or null when there is no selection. */
export function nativeSelectionCarets(
  model: DiffDocumentModel,
  selection: DiffSelection | null,
): { start: NativeSelectionCaret; end: NativeSelectionCaret } | null {
  if (!selection) return null;
  const { start, end } = orderedSelection(selection);
  const startCaret = caretAt(model, start, "forward");
  const endCaret = caretAt(model, end, "backward");
  return startCaret && endCaret ? { start: startCaret, end: endCaret } : null;
}

export function nativeCaretViewportX(
  caret: NativeSelectionCaret,
  horizontalOffsets: Readonly<DiffHorizontalOffsets>,
): number {
  "worklet";
  return (
    caret.x -
    (caret.scrollsHorizontally ? horizontalOffsetForPath(horizontalOffsets, caret.path) : 0)
  );
}

/** Source text without line numbers; empty for a collapsed or missing selection. */
export function nativeSelectedText(
  model: DiffDocumentModel,
  selection: DiffSelection | null,
): string {
  return selection ? selectedSourceText(model, selection) : "";
}

function pictureColumn(columnCount: number, cellIndex: number): NativeSelectionColumn {
  if (columnCount === 1) return "unified";
  return cellIndex === 0 ? "left" : "right";
}

function caretAt(
  model: DiffDocumentModel,
  position: DiffCharacterPosition,
  affinity: "forward" | "backward",
): NativeSelectionCaret | null {
  const row = model.rows[position.rowIndex];
  if (!row || row.kind !== "line") return null;
  const cell = row.cells[position.cellIndex];
  const file = model.files[row.fileIndex];
  if (!cell || !file) return null;
  const columnWidth = model.viewportWidth / row.cells.length;
  const clipX = position.cellIndex * columnWidth + file.gutterWidth + CODE_LEFT_PADDING;
  const offset = position.sourceOffset;
  const fragments = cell.fragments;
  // At a wrap boundary a start caret belongs to the next line, an end caret to the previous.
  const fragment =
    fragments.find((candidate, index) =>
      affinity === "forward"
        ? offset < candidate.end || index === fragments.length - 1
        : offset <= candidate.end,
    ) ?? fragments.at(-1);
  return {
    fileIndex: row.fileIndex,
    path: row.path,
    x: clipX + (fragment ? fragmentWidthForRange(fragment, fragment.start, offset) : 0),
    top: row.top + (fragment?.top ?? 0),
    height: model.lineHeight,
    clipX,
    clipWidth: columnWidth - file.gutterWidth - CODE_LEFT_PADDING,
    scrollsHorizontally: !model.wrapLines,
  };
}

/** Inputs whose change invalidates selection coordinates, matching the web surface. */
export interface NativeDiffSelectionScope {
  files: DiffSurfaceProps["files"];
  layout: DiffDocumentModel["layout"];
  collapsedFilePaths: ReadonlySet<string>;
  typography: DiffTypography;
}

export interface ScopedNativeSelection {
  scope: NativeDiffSelectionScope;
  selection: DiffSelection;
}

/**
 * Drops a selection in the same render its scope changes, so it never paints or
 * copies against rows it no longer describes. Wrapping, width and scrolling keep it.
 */
export function selectionForScope(
  state: ScopedNativeSelection | null,
  scope: NativeDiffSelectionScope,
): DiffSelection | null {
  return state && sameScope(state.scope, scope) ? state.selection : null;
}

function sameScope(left: NativeDiffSelectionScope, right: NativeDiffSelectionScope): boolean {
  return (
    left.files === right.files &&
    left.layout === right.layout &&
    left.collapsedFilePaths === right.collapsedFilePaths &&
    left.typography === right.typography
  );
}
