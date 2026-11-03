import type { ViewToken } from "react-native";
import { scrollOffsetForDelta } from "@/find-highlight/reveal";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { BottomAnchorMode } from "./bottom-anchor-controller";
import {
  createNativeReadingAnchor,
  createNativeRowGeometry,
  findRowIndex,
  getReadingRowIdFromGeometry,
  planScrollToIndexRetry,
  type NativeRowLayout,
  type ViewableRow,
} from "./reading-anchor";

// A programmatic scroll owns the viewport until its scroll events stop for this long.
const PROGRAMMATIC_SCROLL_QUIET_MS = 200;
// Rows rewrap over several frames after a width change. Restore the reader once the content
// height holds still, or after about a second if it never does.
const READING_RESTORE_STABLE_FRAMES = 3;
const READING_RESTORE_MAX_FRAMES = 60;

/** The inverted FlatList and the measurements the host keeps for it. */
export interface NativeReadingListPort {
  scrollToIndex(params: { index: number; viewPosition: number; animated: boolean }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
  /** Lets the next few scroll events near the bottom pass as programmatic (upstream's budget). */
  armScrollBudget(): void;
  offsetY(): number;
  viewportHeight(): number;
  contentHeight(): number;
  /** History rows, newest first, as the list renders them. */
  rows(): readonly StreamItem[];
  /** The newest row, live or history: the reading row when no row is viewable. */
  newestRowId(): string | undefined;
}

/** The part of upstream's bottom anchor the reading position may use. */
export interface NativeReadingAnchorPort {
  mode(): BottomAnchorMode;
  detachByUser(): void;
}

export interface NativeReadingTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  requestFrame(callback: () => void): void;
}

/**
 * Which row the native reader is on, and keeping them on it: jumps by row id with retries,
 * a frozen reading row across width changes, and marking its own scrolls as programmatic so
 * upstream's bottom anchor does not mistake them for the reader. The host forwards list
 * events at the points its comments name; upstream's bottom anchor stays in the host.
 */
export function createNativeReadingPosition(input: {
  list: NativeReadingListPort;
  anchor: NativeReadingAnchorPort;
  timers: NativeReadingTimers;
  onReadingPositionChange: (rowId: string | null) => void;
  onNearBottomChange: (nearBottom: boolean) => void;
}) {
  const { list, anchor, timers } = input;
  const readingAnchor = createNativeReadingAnchor();
  const geometry = createNativeRowGeometry();
  // The last viewable set FlatList reported; null until it reports one.
  let viewableRows: ViewableRow[] | null = null;
  let quietTimer: unknown = null;
  let retries = 0;
  let retryAnimated = true;
  // Retries aim at this row, not at an index: rows merged meanwhile shift indices.
  let targetRowId: string | null = null;
  let settleFrames = 0;
  let stableFrames = 0;
  let settleContentHeight = 0;

  // Jumps, find and held reading positions can land near the bottom. Until their scroll
  // events go quiet, a move toward the bottom is theirs, not the reader returning to it.
  function holdProgrammaticScroll(): void {
    if (quietTimer !== null) timers.clearTimeout(quietTimer);
    quietTimer = timers.setTimeout(() => {
      quietTimer = null;
    }, PROGRAMMATIC_SCROLL_QUIET_MS);
  }

  // The viewable set only changes when a row enters or leaves, but the reading row also
  // changes as the reading line crosses a row edge, or as a viewable row resizes.
  // A resize arrives inside onLayout, possibly ahead of a rotation freeze and with the old
  // offset, so it moves the tick without feeding the rotation restore's remembered row.
  function updateReadingRow(rememberRow: boolean): void {
    if (viewableRows === null) return;
    const rowId = getReadingRowIdFromGeometry({
      rows: viewableRows,
      geometry,
      offsetY: list.offsetY(),
      viewportHeight: list.viewportHeight(),
      newestRowId: list.newestRowId(),
    });
    if (rememberRow) readingAnchor.noteViewable(rowId);
    input.onReadingPositionChange(rowId);
  }

  // A jump detaches from the bottom so streaming output does not pull the reader back.
  // The list is inverted, so viewPosition 1 puts the message's start at the top.
  function jumpToRow(index: number, animated: boolean): void {
    retries = 0;
    targetRowId = list.rows()[index]?.id ?? null;
    retryAnimated = animated;
    anchor.detachByUser();
    holdProgrammaticScroll();
    input.onNearBottomChange(false);
    // Live rows live in the list header, at offset zero of the inverted list.
    if (index < 0) {
      list.scrollToOffset({ offset: 0, animated });
      return;
    }
    list.armScrollBudget();
    list.scrollToIndex({ index, viewPosition: 1, animated });
  }

  // Resolve the target again when the retry runs: rows can merge in the frame between.
  function retryScrollToIndex(): void {
    const index = findRowIndex(list.rows(), targetRowId);
    if (index === null) return;
    list.scrollToIndex({ index, viewPosition: 1, animated: retryAnimated });
  }

  // Freeze the reader before FlatList reports rows from the rewrapped layout. Android can
  // report the resize in a scroll event before onLayout; both run ahead of viewability.
  function beginRestore(previousWidth: number, width: number): boolean {
    return readingAnchor.beginViewportChange({
      previousWidth,
      width,
      detached: anchor.mode() === "detached",
    });
  }

  return {
    /** Cell geometry: record before FlatList's own onLayout, whose viewability pass reads it. */
    rowLayout(rowId: string, layout: NativeRowLayout): void {
      if (!geometry.record(rowId, layout)) return;
      if (viewableRows?.some((row) => row.id === rowId)) updateReadingRow(false);
    },
    forgetRow(rowId: string): void {
      geometry.forget(rowId);
    },
    /**
     * First thing in the scroll handler, before the host records the new offset: the freeze
     * compares against the previous width. Returns whether the event is a programmatic
     * scroll's, and whether a width change started a restore that needs the settle.
     */
    scrollStart(event: { previousWidth: number; width: number; userScrollActive: boolean }): {
      programmatic: boolean;
      startSettle: boolean;
    } {
      const programmatic = quietTimer !== null;
      // A long animated jump keeps its scroll events programmatic all the way down.
      if (programmatic) holdProgrammaticScroll();
      const startSettle =
        !event.userScrollActive &&
        !readingAnchor.isRestorePending() &&
        beginRestore(event.previousWidth, event.width);
      return { programmatic, startSettle };
    },
    /** After the host records the offset, before it tells the bottom anchor. */
    scrollEnd(): void {
      updateReadingRow(true);
    },
    /** The list's own size changed; the host starts its settle right after. */
    viewportChanged(previousWidth: number, width: number): void {
      beginRestore(previousWidth, width);
    },
    /** FlatList's onViewableItemsChanged; stable, as FlatList requires. */
    viewableItemsChanged({ viewableItems }: { viewableItems: ViewToken<StreamItem>[] }): void {
      viewableRows = viewableItems.map((token) => ({
        id: token.item.id,
        index: token.index,
        isViewable: token.isViewable,
      }));
      updateReadingRow(true);
    },
    /** A drag always wins over a pending restore. */
    beginDrag(): void {
      readingAnchor.cancel();
    },
    /** Jump to bottom: cancel first, so a late restore cannot undo it. */
    cancel(): void {
      readingAnchor.cancel();
    },
    /** Hold the reader where they are; a pending restore still runs. */
    hold(): void {
      anchor.detachByUser();
      holdProgrammaticScroll();
    },
    jumpToMessage(messageId: string): void {
      readingAnchor.cancel();
      jumpToRow(
        list.rows().findIndex((row) => getStreamItemMessageId(row) === messageId),
        true,
      );
    },
    // Find measures right after it jumps, so its jumps land at once instead of animating.
    jumpToItem(itemId: string): void {
      readingAnchor.cancel();
      jumpToRow(
        list.rows().findIndex((row) => row.id === itemId),
        false,
      );
    },
    scrollByWindowDelta(delta: number): void {
      readingAnchor.cancel();
      anchor.detachByUser();
      holdProgrammaticScroll();
      input.onNearBottomChange(false);
      list.armScrollBudget();
      list.scrollToOffset({
        offset: scrollOffsetForDelta(list.offsetY(), delta, true),
        animated: false,
      });
    },
    scrollToIndexFailed(info: { averageItemLength: number }): void {
      const retry = planScrollToIndexRetry({
        rows: list.rows(),
        targetRowId,
        averageItemLength: info.averageItemLength,
        attempts: retries,
      });
      if (!retry) return;
      retries += 1;
      holdProgrammaticScroll();
      list.armScrollBudget();
      list.scrollToOffset({ offset: retry.estimatedOffset, animated: false });
      timers.requestFrame(retryScrollToIndex);
    },
    /** The host started its viewport settle. */
    settleStart(): void {
      settleFrames = 0;
      stableFrames = 0;
      settleContentHeight = list.contentHeight();
    },
    /** Each settle frame: whether a pending restore needs the settle to keep running. */
    settleFrame(): boolean {
      settleFrames += 1;
      const contentHeight = list.contentHeight();
      stableFrames = contentHeight === settleContentHeight ? stableFrames + 1 : 0;
      settleContentHeight = contentHeight;
      return (
        readingAnchor.isRestorePending() &&
        stableFrames < READING_RESTORE_STABLE_FRAMES &&
        settleFrames < READING_RESTORE_MAX_FRAMES
      );
    },
    /**
     * The settle ended: put a frozen reader back through the jump path, whose retries and
     * programmatic budget keep the correction from counting as a user scroll. A re-stick
     * during the settle drops the restore.
     */
    settled(): void {
      const rowId = readingAnchor.takeRestoreRowId();
      if (rowId === null || anchor.mode() !== "detached") return;
      const index = list.rows().findIndex((row) => row.id === rowId);
      if (index >= 0) jumpToRow(index, false);
    },
    /** A different agent: nothing viewable yet and nothing to restore. */
    reset(): void {
      viewableRows = null;
      readingAnchor.cancel();
    },
    dispose(): void {
      if (quietTimer !== null) timers.clearTimeout(quietTimer);
      quietTimer = null;
    },
  };
}

export type NativeReadingPosition = ReturnType<typeof createNativeReadingPosition>;
