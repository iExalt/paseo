interface RowGeometry {
  id: string;
  top: number;
  height: number;
}

// A row must clear the reading line before the next row takes ownership.
const READING_POSITION_OFFSET_PX = 8;
export interface ReadingRowReplacements {
  get(id: string): string | undefined;
}
const NO_REPLACEMENTS: ReadingRowReplacements = new Map();

// FlatList reads this once at mount and throws unless exactly one threshold is set. A per-item
// threshold of 0 counts any row with a visible pixel. The list viewport includes the padding
// under the top overlay, so rows beneath it count as visible.
export const READING_VIEWABILITY_CONFIG = Object.freeze({ itemVisiblePercentThreshold: 0 });

export interface ViewableRow {
  id: string;
  index: number | null;
  isViewable: boolean;
}

// The native list is inverted, so its highest viewable index is the row at the top of the
// viewport: the one being read. With none viewable, the reader is at the newest row, as on web.
export function getTopmostViewableRowId(
  rows: readonly ViewableRow[],
  newestRowId: string | undefined,
): string | null {
  let top: ViewableRow | null = null;
  for (const row of rows) {
    if (row.isViewable && row.index !== null && (!top || row.index > (top.index ?? -1))) {
      top = row;
    }
  }
  return top?.id ?? newestRowId ?? null;
}

export interface NativeRowLayout {
  y: number;
  height: number;
}

// Content-coordinate frames of mounted native rows, by row id. FlatList exposes no geometry
// of its own, so cells record theirs here as they lay out.
export function createNativeRowGeometry() {
  const layouts = new Map<string, NativeRowLayout>();
  return {
    get: (id: string) => layouts.get(id),
    // Returns whether the frame changed, so a resize can re-evaluate the reading row.
    record(id: string, layout: NativeRowLayout): boolean {
      const previous = layouts.get(id);
      if (previous && previous.y === layout.y && previous.height === layout.height) return false;
      layouts.set(id, { y: layout.y, height: layout.height });
      return true;
    },
    forget(id: string) {
      layouts.delete(id);
    },
  };
}

// Native counterpart of createReadingAnchor().readingRow. The list is inverted, so content
// y runs upward from the visual bottom: a row's visual bottom is its y, and the viewport top
// is offsetY + viewportHeight. A row owns the reading position once its bottom clears the
// reading line below that top, so a sliver of the previous turn does not take it. Without a
// viewport height or the geometry of every viewable row, the topmost viewable row stands in.
export function getReadingRowIdFromGeometry(input: {
  rows: readonly ViewableRow[];
  geometry: Pick<ReturnType<typeof createNativeRowGeometry>, "get">;
  offsetY: number;
  viewportHeight: number;
  newestRowId: string | undefined;
}): string | null {
  const { rows, geometry, offsetY, viewportHeight, newestRowId } = input;
  const fallback = () => getTopmostViewableRowId(rows, newestRowId);
  if (viewportHeight <= 0) return fallback();
  const readingLine = offsetY + viewportHeight - READING_POSITION_OFFSET_PX;
  let reading: ViewableRow | null = null;
  for (const row of rows) {
    if (!row.isViewable || row.index === null) continue;
    const layout = geometry.get(row.id);
    if (!layout) return fallback();
    if (layout.y < readingLine && (!reading || row.index > (reading.index ?? -1))) {
      reading = row;
    }
  }
  return reading?.id ?? newestRowId ?? null;
}

// Content coordinates survive user scrolling. Layout commits replace the geometry;
// scroll events reuse it, without another DOM measurement pass.
export function createReadingAnchor() {
  let anchor: { id: string; top: number } | null = null;
  let geometry: readonly RowGeometry[] = [];
  const readingRow = (scrollTop: number) =>
    geometry.find((row) => row.top + row.height > scrollTop + READING_POSITION_OFFSET_PX);
  const getRowId = (replacements = NO_REPLACEMENTS) =>
    anchor ? (replacements.get(anchor.id) ?? anchor.id) : null;
  const project = (
    scrollTop: number,
    row: Pick<RowGeometry, "id" | "top"> | undefined,
    replacements = NO_REPLACEMENTS,
  ) => scrollTop + (anchor && row && row.id === getRowId(replacements) ? row.top - anchor.top : 0);
  return {
    getRowId,
    getReadingRowId: (scrollTop: number) =>
      readingRow(scrollTop)?.id ?? geometry.at(-1)?.id ?? null,
    project,
    reset() {
      anchor = null;
    },
    scroll(scrollTop: number) {
      const next = readingRow(scrollTop);
      anchor = next ? { id: next.id, top: next.top } : null;
    },
    reconcile(
      scrollTop: number,
      rows: readonly RowGeometry[],
      userScrolled = false,
      replacements = NO_REPLACEMENTS,
    ): number {
      geometry = rows;
      const previous = anchor && rows.find((row) => row.id === getRowId(replacements));
      // The first virtualized commit can precede its mounted range. Keep the
      // pinned reader until it mounts, rather than adopting an unrelated row.
      if (anchor && !previous && !userScrolled) return scrollTop;
      const correctedTop = project(scrollTop, previous ?? undefined, replacements);
      // A prepend can expose the bottom of an estimated row above the reader.
      // Do not transfer ownership to it until the user moves the reading position.
      const next = previous && !userScrolled ? previous : readingRow(correctedTop);
      anchor = next ? { id: next.id, top: next.top } : null;
      return correctedTop;
    },
  };
}

// A row id can be reported before its timeline position resolves, so the tick dedupes on the
// resolved position: the same row reported again with a new seq must still go through.
export function createReadingSeqDedupe() {
  let last: number | null | undefined;
  return {
    shouldForward(seq: number | null): boolean {
      if (seq === last) return false;
      last = seq;
      return true;
    },
    reset() {
      last = undefined;
    },
  };
}

export const MAX_SCROLL_TO_INDEX_RETRIES = 10;

export function findRowIndex(rows: readonly { id: string }[], rowId: string | null): number | null {
  if (rowId === null) return null;
  const index = rows.findIndex((row) => row.id === rowId);
  return index >= 0 ? index : null;
}

// Rows far from the window have no measured layout yet: the list jumps near an estimate,
// lets them render, then aims again. Bounded so an unreachable row cannot loop. Rows merged
// while a retry waits shift indices (newer rows land at lower indices of the inverted list),
// so the retry finds its target by id. A target that left the list ends the retries.
export function planScrollToIndexRetry(input: {
  rows: readonly { id: string }[];
  targetRowId: string | null;
  averageItemLength: number;
  attempts: number;
}): { index: number; estimatedOffset: number } | null {
  if (input.attempts >= MAX_SCROLL_TO_INDEX_RETRIES) return null;
  const index = findRowIndex(input.rows, input.targetRowId);
  if (index === null) return null;
  return { index, estimatedOffset: input.averageItemLength * index };
}

// FlatList exposes no row geometry, so the native list holds the reader by row id. A width
// change rewraps every row and Android's maintainVisibleContentPosition cannot hold an
// inverted, virtualized list in place, so a detached reader would land elsewhere. Height
// changes (keyboard, composer growth) do not rewrap rows and keep the native behavior.
export function createNativeReadingAnchor() {
  let readingRowId: string | null = null;
  let frozenRowId: string | null = null;
  return {
    // Reports during a reflow come from the drifting layout, so the frozen row wins.
    noteViewable(rowId: string | null) {
      if (frozenRowId === null) readingRowId = rowId;
    },
    // Returns whether a restore is pending after this change.
    beginViewportChange(change: {
      previousWidth: number;
      width: number;
      detached: boolean;
    }): boolean {
      if (frozenRowId !== null) return true;
      // Layout and scroll events can round widths differently; a reflow moves whole pixels.
      const reflowed =
        change.previousWidth > 0 && Math.abs(change.width - change.previousWidth) >= 1;
      if (!change.detached || !reflowed || readingRowId === null) return false;
      frozenRowId = readingRowId;
      return true;
    },
    isRestorePending: () => frozenRowId !== null,
    takeRestoreRowId(): string | null {
      const rowId = frozenRowId;
      frozenRowId = null;
      return rowId;
    },
    cancel() {
      frozenRowId = null;
    },
  };
}
