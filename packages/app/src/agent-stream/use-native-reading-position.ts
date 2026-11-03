import { useEffect, useState, type RefObject } from "react";
import type { FlatList } from "react-native";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import type { BottomAnchorMode } from "./bottom-anchor-controller";
import { createNativeReadingPosition, type NativeReadingPosition } from "./native-reading-position";

/**
 * The native list's reading position, bound to the host's list, measurements and bottom
 * anchor. The ports read this render's values when called, so the instance stays stable for
 * FlatList, which reads some callbacks once at mount.
 */
export function useNativeReadingPosition(input: {
  flatListRef: RefObject<FlatList<StreamItem> | null>;
  scrollOffsetYRef: RefObject<number>;
  metricsRef: RefObject<{ viewportHeight: number; contentHeight: number }>;
  /** Upstream's programmatic scroll event budget. */
  scrollBudgetRef: RefObject<number>;
  historyRows: readonly StreamItem[];
  newestRowId: string | undefined;
  /** Read when called: upstream creates its bottom anchor after the settle that needs this. */
  getBottomAnchor: () => { mode: BottomAnchorMode; detachByUser(): void };
  onReadingPositionChange: ((rowId: string | null) => void) | undefined;
  onNearBottomChange: (nearBottom: boolean) => void;
}): NativeReadingPosition {
  const latest = useStableEvent(() => input);
  const [readingPosition] = useState(() =>
    createNativeReadingPosition({
      list: {
        scrollToIndex: (params) => latest().flatListRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => latest().flatListRef.current?.scrollToOffset(params),
        armScrollBudget: () => {
          latest().scrollBudgetRef.current = 3;
        },
        offsetY: () => latest().scrollOffsetYRef.current,
        viewportHeight: () => latest().metricsRef.current.viewportHeight,
        contentHeight: () => latest().metricsRef.current.contentHeight,
        rows: () => latest().historyRows,
        newestRowId: () => latest().newestRowId,
      },
      anchor: {
        mode: () => latest().getBottomAnchor().mode,
        detachByUser: () => latest().getBottomAnchor().detachByUser(),
      },
      timers: {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        requestFrame: (callback) => void requestAnimationFrame(callback),
      },
      onReadingPositionChange: (rowId) => latest().onReadingPositionChange?.(rowId),
      onNearBottomChange: (nearBottom) => latest().onNearBottomChange(nearBottom),
    }),
  );
  useEffect(() => () => readingPosition.dispose(), [readingPosition]);
  return readingPosition;
}
