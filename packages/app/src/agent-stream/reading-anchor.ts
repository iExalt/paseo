import type { DisclosureTriggerEdge } from "./strategy";

interface RowGeometry {
  id: string;
  top: number;
  height: number;
}

const edgeOf = (row: RowGeometry, edge: DisclosureTriggerEdge) =>
  edge === "top" ? row.top : row.top + row.height;

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

interface ViewableRow {
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

// Content coordinates survive user scrolling. Layout commits replace the geometry;
// scroll events reuse it, without another DOM measurement pass.
export function createReadingAnchor() {
  // The row being read keeps its top. A disclosure pins the edge of its row the trigger sits on,
  // with the offset at the toggle: a toggle that shrinks the content lets the browser clamp the
  // offset before the next reconcile reads it.
  let anchor: {
    id: string;
    edge: DisclosureTriggerEdge;
    position: number;
    pinnedScrollTop?: number;
  } | null = null;
  const anchorTop = (row: RowGeometry) => ({ id: row.id, edge: "top" as const, position: row.top });
  let geometry: readonly RowGeometry[] = [];
  const readingRow = (scrollTop: number) =>
    geometry.find((row) => row.top + row.height > scrollTop + READING_POSITION_OFFSET_PX);
  const getRowId = (replacements = NO_REPLACEMENTS) =>
    anchor ? (replacements.get(anchor.id) ?? anchor.id) : null;
  const project = (
    scrollTop: number,
    row: RowGeometry | undefined,
    replacements = NO_REPLACEMENTS,
  ) =>
    anchor && row && row.id === getRowId(replacements)
      ? (anchor.pinnedScrollTop ?? scrollTop) + edgeOf(row, anchor.edge) - anchor.position
      : scrollTop;
  return {
    getRowId,
    getReadingRowId: (scrollTop: number) =>
      readingRow(scrollTop)?.id ?? geometry.at(-1)?.id ?? null,
    project,
    reset() {
      anchor = null;
    },
    // A disclosure names the row that owns its trigger and the edge the trigger sits on. That
    // edge stays in place through the toggle, even when another row sits under the reading line.
    pin(row: RowGeometry, edge: DisclosureTriggerEdge, scrollTop: number) {
      anchor = { id: row.id, edge, position: edgeOf(row, edge), pinnedScrollTop: scrollTop };
    },
    scroll(scrollTop: number) {
      const next = readingRow(scrollTop);
      anchor = next ? anchorTop(next) : null;
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
      anchor = next ? anchorTop(next) : null;
      return correctedTop;
    },
  };
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
