import {
  Fragment,
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Platform,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ListRenderItemInfo,
  type ViewToken,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useKeyboardStreamInset } from "@/keyboard/shift";
import {
  type ViewableRow,
  createNativeReadingAnchor,
  createNativeRowGeometry,
  findRowIndex,
  getReadingRowIdFromGeometry,
  planScrollToIndexRetry,
  READING_VIEWABILITY_CONFIG,
} from "./reading-anchor";
import { planNativeScrollToBottom } from "./native-scroll-animation";
import { useRevisedHistoryRows } from "./history-row-revision";
import { ChatFindRowFrame } from "./chat-find/row-frame";
import { scrollOffsetForDelta } from "@/find-highlight/reveal";
import { useBottomAnchorController } from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
} from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  HISTORY_START_THRESHOLD_PX,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import { useStreamTopOverlayInset } from "./top-overlay";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const NATIVE_HISTORY_PREFETCH_VIEWPORTS = 2;

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  flexShrink: 0,
};
const HISTORY_START_SETTLE_FRAMES = 2;
const NATIVE_VIEWPORT_SETTLE_FRAMES = 4;
// Rows rewrap over several frames after a width change. Restore the reader once the content
// height holds still, or after about a second if it never does.
const READING_RESTORE_STABLE_FRAMES = 3;
const READING_RESTORE_MAX_FRAMES = 60;
const NATIVE_STREAM_WINDOW_SIZE = 10;

interface NativeRowGeometryContextValue {
  geometry: ReturnType<typeof createNativeRowGeometry>;
  onRowResized: (rowId: string) => void;
}

const NativeRowGeometryContext = createContext<NativeRowGeometryContextValue | null>(null);

interface NativeStreamCellProps {
  cellKey: string;
  children: ReactNode;
  onFocusCapture?: ((event: never) => void) | undefined;
  onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
  style: StyleProp<ViewStyle> | undefined;
}

// FlatList exposes no row geometry, so each cell reports its own frame on layout. The cell
// is a plain View with the props FlatList would give it. The component is module-level so
// its identity is stable and cells never remount.
function NativeStreamCell({
  cellKey,
  children,
  onFocusCapture,
  onLayout,
  style,
}: NativeStreamCellProps) {
  const context = useContext(NativeRowGeometryContext);
  useEffect(() => () => context?.geometry.forget(cellKey), [cellKey, context]);
  // Record before FlatList's handler: its viewability pass runs inside it and reads the frame.
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      if (context?.geometry.record(cellKey, { y, height })) context.onRowResized(cellKey);
      onLayout?.(event);
    },
    [cellKey, context, onLayout],
  );
  // RN's View typings omit the capture-phase focus prop FlatList's own cell sets.
  const focusProps = { onFocusCapture };
  return (
    <View style={style} onLayout={handleLayout} {...focusProps}>
      {children}
    </View>
  );
}

function keyExtractor(item: { id: string }): string {
  return item.id;
}

function NativeStreamViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    historyRowRevision,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onReadingPositionChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const flatListRef = useRef<FlatList<StreamItem>>(null);
  const streamViewportMetricsRef = useRef({
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });
  const scrollOffsetYRef = useRef(0);
  const isUserScrollActiveRef = useRef(false);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss();
  const streamKeyboardInset = useKeyboardStreamInset();
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const programmaticScrollEventBudgetRef = useRef(0);
  const isNativeViewportSettlingRef = useRef(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const [readingAnchor] = useState(createNativeReadingAnchor);
  const [rowGeometry] = useState(createNativeRowGeometry);
  // The last viewable set FlatList reported; null until it reports one.
  const viewableRowsRef = useRef<ViewableRow[] | null>(null);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  const historyRows = useRevisedHistoryRows(historyItems, historyRowRevision);
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = streamViewportMetricsRef.current;
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.contentHeight - metrics.viewportHeight - metrics.offsetY,
      // Request older history while the reader is still a screen or two away, so the round
      // trip and first render finish before they reach the top.
      historyStartThresholdPx: Math.max(
        HISTORY_START_THRESHOLD_PX,
        metrics.viewportHeight * NATIVE_HISTORY_PREFETCH_VIEWPORTS,
      ),
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && hasMeasuredViewport,
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (transition.shouldLoad) {
        const requestedProgressKey = olderHistoryProgressKey;
        if (requestedProgressKey === null) {
          return;
        }
        void (async () => {
          const started = await onNearHistoryStart();
          if (started === true) {
            return;
          }
          applyHistoryStartPaginationTransition({
            state: abandonHistoryStartPaginationRequest(
              historyStartPaginationStateRef.current,
              requestedProgressKey,
            ),
            shouldLoad: false,
          });
        })();
      }
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      getHistoryStartPaginationInput(),
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => {
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            getHistoryStartPaginationInput(),
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const getBottomAnchorTransportBehavior = useCallback(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettlingRef.current,
      }),
    [strategy],
  );

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      const plan = planNativeScrollToBottom({
        animated,
        offsetY: scrollOffsetYRef.current,
        viewportHeight: streamViewportMetricsRef.current.viewportHeight,
        windowSize: NATIVE_STREAM_WINDOW_SIZE,
      });
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({ offset: 0, animated: plan.animated });
      scrollOffsetYRef.current = plan.recordedOffsetY;
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        offsetY: plan.recordedOffsetY,
      };
      onNearBottomChange(true);
    },
    [onNearBottomChange],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "inverted-stream",
    getTransportBehavior: getBottomAnchorTransportBehavior,
    getMeasurementState: () => streamViewportMetricsRef.current,
    isNearBottom: () => {
      const metrics = streamViewportMetricsRef.current;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: metrics.offsetY,
        threshold: 32,
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
      });
    },
    scrollToBottom,
  });
  // Android's maintainVisibleContentPosition ignores the list inversion transform and
  // fights the controller's offset-zero correction while the live header grows.
  const maintainVisibleContentPosition =
    Platform.OS === "android" && bottomAnchorController.mode === "sticky-bottom"
      ? undefined
      : DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION;
  const topOverlayInset = useStreamTopOverlayInset();
  // The list is inverted, so its content's bottom padding is the visual top.
  const listContentContainerStyle = useMemo(
    () => [
      baseListContentContainerStyle,
      {
        paddingBottom: streamKeyboardInset.contentContainerPaddingBottom + topOverlayInset,
      },
    ],
    [
      baseListContentContainerStyle,
      streamKeyboardInset.contentContainerPaddingBottom,
      topOverlayInset,
    ],
  );
  const listInsetProps = useMemo(
    () =>
      streamKeyboardInset.contentInset
        ? {
            automaticallyAdjustContentInsets: false,
            automaticallyAdjustsScrollIndicatorInsets: false,
            contentInsetAdjustmentBehavior: "never" as const,
            contentInset: streamKeyboardInset.contentInset,
            scrollIndicatorInsets: streamKeyboardInset.contentInset,
          }
        : {},
    [streamKeyboardInset.contentInset],
  );

  useEffect(() => {
    streamViewportMetricsRef.current = {
      containerKey: "native-virtualized",
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      offsetY: 0,
      viewportMeasuredForKey: null,
      contentMeasuredForKey: null,
    };
    scrollOffsetYRef.current = 0;
    viewableRowsRef.current = null;
    isUserScrollActiveRef.current = false;
    clearPendingUserScrollEnd();
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = false;
    readingAnchor.cancel();
    historyStartReadyRef.current = false;
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearPendingUserScrollEnd();
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [
    agentId,
    clearNativeViewportSettling,
    clearPendingUserScrollEnd,
    evaluateHistoryStart,
    readingAnchor,
  ]);

  useEffect(() => () => clearNativeViewportSettling(), [clearNativeViewportSettling]);

  useEffect(() => {
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, segments.liveHead]);

  // A jump detaches from the bottom so streaming output does not pull the reader back.
  // The list is inverted, so viewPosition 1 puts the message's start at the top.
  const scrollToIndexRetriesRef = useRef(0);
  const scrollToIndexAnimatedRef = useRef(true);
  // Retries aim at this row, not at an index: rows merged meanwhile shift indices.
  const scrollToIndexTargetRowIdRef = useRef<string | null>(null);
  const jumpToRow = useStableEvent((index: number, animated: boolean) => {
    scrollToIndexRetriesRef.current = 0;
    scrollToIndexTargetRowIdRef.current = historyRows[index]?.id ?? null;
    scrollToIndexAnimatedRef.current = animated;
    bottomAnchorController.detachByUser();
    onNearBottomChange(false);
    // Live rows live in the list header, at offset zero of the inverted list.
    if (index < 0) {
      flatListRef.current?.scrollToOffset({ offset: 0, animated });
      return;
    }
    programmaticScrollEventBudgetRef.current = 3;
    flatListRef.current?.scrollToIndex({ index, viewPosition: 1, animated });
  });
  // The restore reuses the jump path: its retries, and the programmatic-scroll budget that
  // keeps the correction from counting as a user scroll.
  const restoreReadingRow = useStableEvent(() => {
    const rowId = readingAnchor.takeRestoreRowId();
    if (rowId === null || bottomAnchorController.mode !== "detached") return;
    const index = historyRows.findIndex((row) => row.id === rowId);
    if (index >= 0) jumpToRow(index, false);
  });
  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = true;
    let frames = 0;
    let stableFrames = 0;
    let contentHeight = streamViewportMetricsRef.current.contentHeight;
    const tick = () => {
      frames += 1;
      const nextContentHeight = streamViewportMetricsRef.current.contentHeight;
      stableFrames = nextContentHeight === contentHeight ? stableFrames + 1 : 0;
      contentHeight = nextContentHeight;
      const awaitsStableContent =
        readingAnchor.isRestorePending() &&
        stableFrames < READING_RESTORE_STABLE_FRAMES &&
        frames < READING_RESTORE_MAX_FRAMES;
      if (frames <= NATIVE_VIEWPORT_SETTLE_FRAMES || awaitsStableContent) {
        nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
        return;
      }
      nativeViewportSettlingFrameIdRef.current = null;
      isNativeViewportSettlingRef.current = false;
      restoreReadingRow();
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling, readingAnchor, restoreReadingRow]);

  const scrollToMessage = useStableEvent((messageId: string) => {
    readingAnchor.cancel();
    jumpToRow(
      historyRows.findIndex((row) => getStreamItemMessageId(row) === messageId),
      true,
    );
  });
  // Find measures right after it jumps, so its jumps land at once instead of animating.
  const scrollToItem = useStableEvent((itemId: string) => {
    readingAnchor.cancel();
    jumpToRow(
      historyRows.findIndex((row) => row.id === itemId),
      false,
    );
  });
  const scrollByWindowDelta = useStableEvent((delta: number) => {
    readingAnchor.cancel();
    bottomAnchorController.detachByUser();
    onNearBottomChange(false);
    programmaticScrollEventBudgetRef.current = 3;
    flatListRef.current?.scrollToOffset({
      offset: scrollOffsetForDelta(scrollOffsetYRef.current, delta, true),
      animated: false,
    });
  });
  const handleScrollToIndexFailed = useStableEvent(
    (info: { index: number; averageItemLength: number }) => {
      const retry = planScrollToIndexRetry({
        rows: historyRows,
        targetRowId: scrollToIndexTargetRowIdRef.current,
        averageItemLength: info.averageItemLength,
        attempts: scrollToIndexRetriesRef.current,
      });
      if (!retry) return;
      scrollToIndexRetriesRef.current += 1;
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({ offset: retry.estimatedOffset, animated: false });
      requestAnimationFrame(retryScrollToIndex);
    },
  );
  // Resolve the target again when the retry runs: rows can merge in the frame between.
  const retryScrollToIndex = useStableEvent(() => {
    const index = findRowIndex(historyRows, scrollToIndexTargetRowIdRef.current);
    if (index === null) return;
    flatListRef.current?.scrollToIndex({
      index,
      viewPosition: 1,
      animated: scrollToIndexAnimatedRef.current,
    });
  });

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: (reason = "jump-to-bottom") => {
        readingAnchor.cancel();
        bottomAnchorController.requestLocalAnchor({
          agentId,
          reason,
        });
      },
      prepareForViewportChange: () => {
        bottomAnchorController.prepareForStickyViewportChange();
        markNativeViewportSettling();
      },
      holdReadingPosition: () => bottomAnchorController.detachByUser(),
      scrollToMessage: (messageId) => scrollToMessage(messageId),
      scrollToItem: (itemId) => scrollToItem(itemId),
      scrollByWindowDelta: (delta) => scrollByWindowDelta(delta),
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [
    agentId,
    bottomAnchorController,
    markNativeViewportSettling,
    readingAnchor,
    scrollByWindowDelta,
    scrollToItem,
    scrollToMessage,
    viewportRef,
  ]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: contentOffset.y,
        threshold: 32,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
  );

  // Freeze the reader before FlatList reports rows from the rewrapped layout. Android can
  // report the resize in a scroll event before onLayout; both run ahead of viewability.
  const beginReadingRestore = useStableEvent((previousWidth: number, width: number) =>
    readingAnchor.beginViewportChange({
      previousWidth,
      width,
      detached: bottomAnchorController.mode === "detached",
    }),
  );

  // The viewable set only changes when a row enters or leaves, but the reading row also
  // changes as the reading line crosses a row edge, or as a viewable row resizes.
  // A resize arrives inside onLayout, possibly ahead of a rotation freeze and with the old
  // offset, so it moves the tick without feeding the rotation restore's remembered row.
  const updateReadingRow = useStableEvent((rememberRow: boolean) => {
    const viewableRows = viewableRowsRef.current;
    if (viewableRows === null) return;
    const rowId = getReadingRowIdFromGeometry({
      rows: viewableRows,
      geometry: rowGeometry,
      offsetY: scrollOffsetYRef.current,
      viewportHeight: streamViewportMetricsRef.current.viewportHeight,
      newestRowId: segments.liveHead.at(-1)?.id ?? historyRows[0]?.id,
    });
    if (rememberRow) readingAnchor.noteViewable(rowId);
    onReadingPositionChange?.(rowId);
  });

  const handleRowResized = useStableEvent((rowId: string) => {
    if (viewableRowsRef.current?.some((row) => row.id === rowId)) updateReadingRow(false);
  });
  const rowGeometryContext = useMemo(
    () => ({ geometry: rowGeometry, onRowResized: handleRowResized }),
    [handleRowResized, rowGeometry],
  );

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    if (
      !isUserScrollActiveRef.current &&
      !readingAnchor.isRestorePending() &&
      beginReadingRestore(previousViewportWidth, Math.max(0, layoutMeasurement.width))
    ) {
      markNativeViewportSettling();
    }
    scrollOffsetYRef.current = contentOffset.y;
    scrollKeyboardDismiss.onScroll(event);

    streamViewportMetricsRef.current = {
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      containerKey: "native-virtualized",
      offsetY: contentOffset.y,
      viewportMeasuredForKey: "native-virtualized",
      contentMeasuredForKey: "native-virtualized",
    };

    const nearBottom = isScrollEventNearBottom(event);
    onNearBottomChange(nearBottom);

    evaluateHistoryStart();
    updateReadingRow(true);

    if (
      !isUserScrollActiveRef.current &&
      programmaticScrollEventBudgetRef.current > 0 &&
      contentOffset.y <= 8
    ) {
      programmaticScrollEventBudgetRef.current -= 1;
    } else {
      programmaticScrollEventBudgetRef.current = 0;
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: nearBottom,
        scrollDelta: contentOffset.y - previousOffsetY,
      });
    }
  });

  const handleScrollBeginDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    clearPendingUserScrollEnd();
    isUserScrollActiveRef.current = true;
    readingAnchor.cancel();
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    bottomAnchorController.beginUserScroll();
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed !== historyStartPaginationStateRef.current) {
      historyStartPaginationStateRef.current = rearmed;
      setHistoryStartPaginationState(rearmed);
      evaluateHistoryStart();
    }
  });

  // Defer drag end so momentum can take ownership, but capture the terminal
  // gesture position now because layout may move the viewport in the meantime.
  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isNearBottom = isScrollEventNearBottom(event);
    scrollKeyboardDismiss.onScrollEndDrag(event);

    clearPendingUserScrollEnd();
    userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    });
  });

  const handleMomentumScrollBegin = useStableEvent(() => {
    clearPendingUserScrollEnd();
  });

  const handleMomentumScrollEnd = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Android can emit momentum-end after a programmatic anchor correction.
      // Only momentum that still owns the user gesture may settle scroll intent.
      if (!isUserScrollActiveRef.current) {
        return;
      }
      const isNearBottom = isScrollEventNearBottom(event);
      clearPendingUserScrollEnd();
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    },
  );

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    const viewportChanged =
      (previousViewportWidth > 0 && previousViewportWidth !== viewportWidth) ||
      (previousViewportHeight > 0 && previousViewportHeight !== viewportHeight);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: "native-virtualized",
    };
    if (viewportChanged) {
      beginReadingRestore(previousViewportWidth, viewportWidth);
      markNativeViewportSettling();
    }
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
    evaluateHistoryStart();
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      contentHeight: nextContentHeight,
      contentMeasuredForKey: "native-virtualized",
    };
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  });

  useEffect(() => {
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartSettle,
  ]);

  const renderItem = useStableEvent(
    ({ item, index }: ListRenderItemInfo<StreamItem>): ReactElement | null => {
      const rendered = renderHistoryMountedRow(item, index, historyItems);
      if (rendered && (item.kind === "user_message" || item.kind === "assistant_message")) {
        return (
          <ChatFindRowFrame messageId={getStreamItemMessageId(item)}>{rendered}</ChatFindRowFrame>
        );
      }
      return (rendered ?? null) as ReactElement | null;
    },
  );

  const handleViewableItemsChanged = useStableEvent(
    ({ viewableItems }: { viewableItems: ViewToken<StreamItem>[] }) => {
      viewableRowsRef.current = viewableItems.map((token) => ({
        id: token.item.id,
        index: token.index,
        isViewable: token.isViewable,
      }));
      updateReadingRow(true);
    },
  );

  const liveHeaderContent = useMemo(() => {
    // Stable render events read the latest expansion state; this revision makes
    // the memo invoke them again when that state changes.
    void liveHeadRowRevision;
    const liveHeadRows = segments.liveHead.map((item, index) => (
      <Fragment key={item.id}>{renderLiveHeadRow(item, index, segments.liveHead)}</Fragment>
    ));
    const liveAuxiliary = renderLiveAuxiliary();
    if (
      liveHeadRows.length === 0 &&
      !liveAuxiliary &&
      !boundary.hasMountedHistory &&
      !boundary.hasVirtualizedHistory
    ) {
      return (listEmptyComponent ?? null) as ReactElement | null;
    }
    return (
      <Fragment>
        {liveHeadRows}
        {liveAuxiliary}
      </Fragment>
    );
  }, [
    boundary,
    listEmptyComponent,
    liveHeadRowRevision,
    renderLiveAuxiliary,
    renderLiveHeadRow,
    segments.liveHead,
  ]);

  const historyFooterContent = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <View style={historyStartSlotStyle} testID="older-history-slot">
        {isLoadingOperation ? (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    );
  }, [historyStartPaginationState]);

  // RN's FlatList strictMode keeps its internal renderItem wrapper stable when
  // data or the live header changes, preserving the row identities above.
  return (
    <NativeRowGeometryContext.Provider value={rowGeometryContext}>
      <FlatList
        {...listInsetProps}
        ref={flatListRef}
        data={historyRows}
        renderItem={renderItem}
        CellRendererComponent={NativeStreamCell}
        keyExtractor={keyExtractor}
        strictMode
        testID="agent-chat-scroll"
        nativeID="agent-chat-scroll-native-virtualized"
        ListHeaderComponent={liveHeaderContent ?? undefined}
        ListFooterComponent={historyFooterContent ?? undefined}
        contentContainerStyle={listContentContainerStyle}
        style={listStyle}
        onLayout={handleListLayout}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}
        onContentSizeChange={handleContentSizeChange}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={READING_VIEWABILITY_CONFIG}
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        // Tall Markdown rows exhaust a shallow window during flings. Keep the initial
        // render small, then refill a deeper window in batches large enough to keep up.
        initialNumToRender={2}
        maxToRenderPerBatch={10}
        windowSize={NATIVE_STREAM_WINDOW_SIZE}
        removeClippedSubviews={false}
        scrollEnabled={scrollEnabled}
        showsVerticalScrollIndicator
        inverted
      />
    </NativeRowGeometryContext.Provider>
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: true,
    orderHeadReverse: true,
    assistantTurnTraversalStep: 1,
    edgeSlot: "header",
    historyLiveBoundaryEdge: "first",
    liveHeadHistoryBoundaryEdge: "last",
    frameChildOrder: "footer-then-content",
    flatListInverted: true,
    overlayScrollbarInverted: true,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => input.offsetY <= input.threshold,
    getBottomOffset: () => 0,
  });
  return strategy;
}
