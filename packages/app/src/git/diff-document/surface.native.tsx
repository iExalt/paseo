import { Canvas, Group, Picture, Rect, type SkPicture } from "@shopify/react-native-skia";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  createAnimatedComponent,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useBackClosesFind } from "@/pane-find/use-back-closes-find";
import { getInlineReviewThreadState, InlineReviewThread } from "@/review";
import { useBackCancelsReviewEditor } from "@/review/use-back-cancels-review-editor";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { useKeyboardShift } from "@/keyboard/shift";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { DocumentFileHeader } from "./document-file-header";
import {
  diffInteractionWindowTop,
  diffMaterializationWindow,
  resolveVisibleFileSections,
} from "./header-layout";
import { hitTestDiffBodyPoint } from "./native-hit-testing";
import { resolveReviewOverlayFrame } from "./review-overlay-geometry";
import { retainDiffViewport } from "./viewport";
import { HorizontalScroll } from "./horizontal-scroll.native";
import {
  horizontalOffsetForPath,
  retainHorizontalOffsetsForPaths,
  type DiffHorizontalOffsets,
} from "./horizontal-offsets";
import {
  buildDiffDocumentModel,
  captureScrollAnchor,
  resolveRelayoutScrollTop,
  retainReusableModels,
  shouldApplyRelayoutScroll,
} from "./model";
import {
  buildNativeCanvasSlabs,
  nativeCanvasSlabsForViewport,
  nativeCanvasWindowBucket,
  nativeCanvasWindowTop,
  type NativeCanvasSlab,
} from "./native-slabs";
import {
  nativeCaretViewportX,
  nativeSelectionCarets,
  nativeSelectionRectsForSlab,
  type NativeSelectionCaret,
  type NativeSelectionGeometry,
  type NativeSelectionRect,
} from "./native-selection";
import {
  IDLE_SELECTION_GESTURE,
  SELECTION_LONG_PRESS_MS,
  isSelectionDragActive,
  reduceSelectionGesture,
  type SelectionGestureEffect,
  type SelectionGestureEvent,
  type SelectionGestureState,
  type SelectionHandle,
} from "./selection-gesture";
import { placeSelectionActionBar } from "./selection-action-bar";
import {
  handleDragPointer,
  longPressDragPointer,
  nextSelectionAutoScrollTop,
  selectionDragPoint,
  selectionDragViewportY,
  type SelectionDragPointer,
} from "./selection-auto-scroll";
import { useNativeDiffSelection } from "./use-native-diff-selection";
import {
  createNativePaints,
  recordNativeHeaderPicture,
  recordNativeSlabPictures,
  type NativePaints,
} from "./paint.native";
import {
  createNativeTextLayoutStore,
  createNativeHeaderTextLayout,
  createNativeTextMeasurer,
  disposeNativeTextLayout,
  prepareNativeTextLayout,
  type NativeTextLayout,
  type NativeHeaderTextLayout,
} from "./text.native";
import type {
  DiffDocumentModel,
  DiffFileSection,
  DiffSelection,
  DiffSurfaceProps,
  DiffTypography,
  TextMeasurer,
} from "./types";

const AnimatedScrollView = createAnimatedComponent(ScrollView);
const SYSTEM_MONO = "monospace";
const CODE_LEFT_PADDING = 8;
/** Matches the web surface's selection fill. */
const SELECTION_OPACITY = 0.45;
/** Minimum touch target for a selection handle. */
const HANDLE_HIT_SIZE = 44;
const HANDLE_KNOB_SIZE = 16;
const HANDLE_STEM_WIDTH = 2;
/** Moves a scrolled-out handle off screen so it can't be grabbed. */
const HIDDEN_HANDLE_X = -10_000;

type SelectionGestureDispatch = (event: SelectionGestureEvent) => SelectionGestureEffect;
type SelectionDragSource = "long-press" | "handle";
type OutsideTouchEvent = Extract<SelectionGestureEvent, { type: `touch-${string}` }>;

/**
 * Tracks the finger of a running long-press or handle drag in viewport space,
 * so edge auto-scroll can keep extending the selection while it stays still.
 */
interface SelectionDragControls {
  beginLongPress: (fileIndex: number, bodyX: number, bodyY: number) => void;
  beginHandle: (caret: NativeSelectionCaret) => void;
  /** The finger's movement since the drag began, in layout pixels. */
  move: (source: SelectionDragSource, deltaX: number, deltaY: number) => void;
  end: (source: SelectionDragSource) => void;
  /** Marks a touch that a file body or handle owns, so the surface doesn't treat it as outside. */
  claimTouch: () => void;
}

export function DiffSurface(props: DiffSurfaceProps) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fileWindowTop, setFileWindowTop] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const previousModelRef = useRef<ReturnType<typeof buildDiffDocumentModel> | null>(null);
  const reusableModelRef = useRef<{
    dependencies: readonly unknown[];
    models: ReturnType<typeof buildDiffDocumentModel>[];
  } | null>(null);
  const consumedFocusRef = useRef<string | null>(null);
  const scrollTop = useSharedValue(0);
  const { shift: keyboardShift } = useKeyboardShift();
  const keyboardSpacerStyle = useAnimatedStyle(
    () => ({ height: keyboardShift.value }),
    [keyboardShift],
  );
  const horizontalOffsets = useSharedValue<DiffHorizontalOffsets>({});
  const family = props.displayPreferences.monoFontFamily.trim() || SYSTEM_MONO;
  const typography = useMemo<DiffTypography>(
    () => ({
      family,
      size: props.displayPreferences.codeFontSize,
      lineHeight: Math.round(props.displayPreferences.codeFontSize * 1.5),
    }),
    [family, props.displayPreferences.codeFontSize],
  );
  const measurement = useMemo<TextMeasurer>(
    () => createNativeTextMeasurer({ configuredFamily: family, fontSize: typography.size }),
    [family, typography.size],
  );
  const reviewActions = props.mode.kind === "working" ? props.mode.reviewActions : undefined;
  const model = useMemo(() => {
    const dependencies = [
      props.displayPreferences.layout,
      props.displayPreferences.wrapLines,
      viewport.width,
      typography,
      measurement,
      props.palette,
      t,
    ] as const;
    const previous = reusableModelRef.current;
    const canReuse = previous?.dependencies.every(
      (dependency, index) => dependency === dependencies[index],
    );
    const reuseFrom = canReuse ? previous?.models : undefined;
    const next = buildDiffDocumentModel({
      files: viewport.width > 0 ? props.files : [],
      collapsedFilePaths: props.collapsedFilePaths,
      layout: props.displayPreferences.layout,
      wrapLines: props.displayPreferences.wrapLines,
      viewportWidth: viewport.width,
      typography,
      measureText: measurement,
      palette: props.palette,
      reviewActions,
      labels: {
        binary: t("workspace.git.diff.binaryFile"),
        tooLarge: t("workspace.git.diff.tooLarge"),
      },
      materializationWindow: diffMaterializationWindow(fileWindowTop, viewport.height),
      materializationAnchor: previousModelRef.current
        ? captureScrollAnchor(previousModelRef.current, scrollTop.get())
        : null,
      reuseFrom,
    });
    reusableModelRef.current = {
      dependencies,
      models: retainReusableModels(reuseFrom, next),
    };
    return next;
  }, [
    measurement,
    fileWindowTop,
    scrollTop,
    props.collapsedFilePaths,
    props.displayPreferences.layout,
    props.displayPreferences.wrapLines,
    props.files,
    props.palette,
    reviewActions,
    t,
    typography,
    viewport.width,
    viewport.height,
  ]);
  const paints = useMemo(() => createNativePaints(props.palette), [props.palette]);
  // Long-press, handles and the action bar drive selection through this controller.
  const selection = useNativeDiffSelection(model, {
    files: props.files,
    layout: props.displayPreferences.layout,
    collapsedFilePaths: props.collapsedFilePaths,
    typography,
  });
  const gestureStateRef = useRef<SelectionGestureState>(IDLE_SELECTION_GESTURE);
  // Several gesture events can land before React re-renders with the new selection.
  const latestSelectionRef = useRef<DiffSelection | null>(selection.selection);
  useLayoutEffect(() => {
    latestSelectionRef.current = selection.selection;
  }, [selection.selection]);
  // Scrolling stays off only while a long-press or handle drag moves the selection.
  const [selectionDragActive, setSelectionDragActive] = useState(false);
  // Set by a body's touch start, which bubbles to the scroll view's handler right after.
  const touchClaimedRef = useRef(false);
  const dispatchSelectionGesture = useStableEvent((event: SelectionGestureEvent) => {
    if (event.type === "touch-start") touchClaimedRef.current = true;
    const result = reduceSelectionGesture(
      { model, horizontalOffsets: horizontalOffsets.value },
      gestureStateRef.current,
      latestSelectionRef.current,
      event,
    );
    gestureStateRef.current = result.state;
    if (result.selection !== latestSelectionRef.current) {
      latestSelectionRef.current = result.selection;
      selection.setSelection(result.selection);
    }
    setSelectionDragActive(isSelectionDragActive(result.state));
    return result.effect;
  });
  const dragRef = useRef<{ source: SelectionDragSource; pointer: SelectionDragPointer } | null>(
    null,
  );
  // A drag never continues against rows that changed under it.
  useEffect(() => {
    gestureStateRef.current = IDLE_SELECTION_GESTURE;
    dragRef.current = null;
    setSelectionDragActive(false);
  }, [props.files, props.displayPreferences.layout, props.collapsedFilePaths, typography]);
  const dispatchSelectionDrag = useStableEvent((pointer: SelectionDragPointer) => {
    const point = selectionDragPoint(model, pointer, scrollTop.value);
    if (point) dispatchSelectionGesture({ type: "drag", point });
  });
  const beginLongPressDrag = useStableEvent((fileIndex: number, bodyX: number, bodyY: number) => {
    const pointer = longPressDragPointer({
      model,
      fileIndex,
      bodyX,
      bodyY,
      scrollTop: scrollTop.value,
    });
    dragRef.current = pointer ? { source: "long-press", pointer } : null;
  });
  const beginHandleDrag = useStableEvent((caret: NativeSelectionCaret) => {
    const pointer = handleDragPointer({
      fileIndex: caret.fileIndex,
      caretViewportX: nativeCaretViewportX(caret, horizontalOffsets.value),
      caretMiddleY: caret.top + caret.height / 2,
      scrollTop: scrollTop.value,
    });
    dragRef.current = { source: "handle", pointer };
  });
  const moveSelectionDrag = useStableEvent(
    (source: SelectionDragSource, deltaX: number, deltaY: number) => {
      const drag = dragRef.current;
      if (drag?.source !== source) return;
      const pointer = { ...drag.pointer, deltaX, deltaY };
      dragRef.current = { source, pointer };
      dispatchSelectionDrag(pointer);
    },
  );
  const endSelectionDrag = useStableEvent((source: SelectionDragSource) => {
    if (dragRef.current?.source === source) dragRef.current = null;
  });
  const claimSelectionTouch = useStableEvent(() => {
    touchClaimedRef.current = true;
  });
  const selectionDrag = useMemo<SelectionDragControls>(
    () => ({
      beginLongPress: beginLongPressDrag,
      beginHandle: beginHandleDrag,
      move: moveSelectionDrag,
      end: endSelectionDrag,
      claimTouch: claimSelectionTouch,
    }),
    [beginHandleDrag, beginLongPressDrag, claimSelectionTouch, endSelectionDrag, moveSelectionDrag],
  );
  const dismissSelection = useStableEvent(() => {
    if (!latestSelectionRef.current) return;
    latestSelectionRef.current = null;
    selection.clearSelection();
  });
  // Taps outside the file bodies and handles (headers, review threads, empty space)
  // run the same tap rules as a body but can only dismiss.
  const outsideTouchRef = useRef<SelectionGestureState>(IDLE_SELECTION_GESTURE);
  const trackOutsideTouch = useStableEvent((event: OutsideTouchEvent) => {
    if (event.type === "touch-start") {
      const claimed = touchClaimedRef.current;
      touchClaimedRef.current = false;
      if (claimed || isSelectionDragActive(gestureStateRef.current)) {
        outsideTouchRef.current = IDLE_SELECTION_GESTURE;
        return;
      }
    }
    const result = reduceSelectionGesture(
      { model, horizontalOffsets: horizontalOffsets.value },
      outsideTouchRef.current,
      latestSelectionRef.current,
      event,
    );
    outsideTouchRef.current = result.state;
    if (result.effect === "dismiss") dismissSelection();
  });
  const outsideTouchStart = useCallback(
    (event: GestureResponderEvent) =>
      trackOutsideTouch({
        type: "touch-start",
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
        time: Date.now(),
      }),
    [trackOutsideTouch],
  );
  const outsideTouchMove = useCallback(
    (event: GestureResponderEvent) =>
      trackOutsideTouch({
        type: "touch-move",
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
      }),
    [trackOutsideTouch],
  );
  const outsideTouchEnd = useCallback(
    () => trackOutsideTouch({ type: "touch-end", time: Date.now() }),
    [trackOutsideTouch],
  );
  const outsideTouchCancel = useCallback(
    () => trackOutsideTouch({ type: "touch-cancel" }),
    [trackOutsideTouch],
  );
  // Android Back clears a selection before it leaves the pane; hidden panes leave Back alone.
  const panelActive = useRetainedPanelActive();
  useBackClosesFind(selection.selection !== null && panelActive, dismissSelection);
  useBackCancelsReviewEditor(
    Boolean(reviewActions?.editor),
    panelActive,
    reviewActions?.onCancelEditor ?? noop,
  );
  const selectAllText = useStableEvent(() => {
    latestSelectionRef.current = selection.selectAll();
  });
  const toast = useToast();
  // Like web's context menu Copy, the selection stays after copying.
  const copySelection = useStableEvent(() => {
    void copyToClipboard(selection.getSelectedText())
      .then(() => toast.copied())
      .catch(() => toast.error(t("common.errors.unableToCopy")));
  });
  const textLayoutStore = useMemo(
    () =>
      createNativeTextLayoutStore({
        configuredFamily: family,
        fontSize: typography.size,
        lineHeight: typography.lineHeight,
        palette: props.palette,
      }),
    [family, props.palette, typography.lineHeight, typography.size],
  );
  const textLayout = useMemo(
    () =>
      prepareNativeTextLayout(
        textLayoutStore,
        model,
        diffMaterializationWindow(fileWindowTop, viewport.height),
      ),
    [model, textLayoutStore, fileWindowTop, viewport.height],
  );
  useEffect(() => () => disposeNativeTextLayout(textLayoutStore), [textLayoutStore]);
  const headerTextLayout = useMemo(
    () =>
      createNativeHeaderTextLayout({
        configuredFamily: props.headerTypography.family,
        fontSize: props.headerTypography.size,
        statFontSize: props.headerTypography.statSize,
        palette: props.palette,
      }),
    [props.headerTypography, props.palette],
  );
  const updateFileWindow = useCallback((nextTop: number) => {
    setFileWindowTop((current) => (current === nextTop ? current : nextTop));
  }, []);
  useAnimatedReaction(
    () => diffInteractionWindowTop(scrollTop.value, viewport.height),
    (windowTop, previous) => {
      if (windowTop !== previous) {
        scheduleOnRN(updateFileWindow, windowTop);
      }
    },
    [updateFileWindow, viewport.height],
  );
  const interactionFiles = useMemo(
    () =>
      resolveVisibleFileSections({
        files: model.files,
        scrollTop: fileWindowTop,
        viewportHeight: viewport.height,
        overscan: viewport.height * 2,
      }).files,
    [fileWindowTop, model.files, viewport.height],
  );

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollTop.value = event.contentOffset.y;
  });

  const layout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => retainDiffViewport(current, { width, height }));
  }, []);
  useLayoutEffect(() => {
    const previous = previousModelRef.current;
    if (previous && previous !== model) {
      const nextScrollTop = resolveRelayoutScrollTop(previous, model, scrollTop.value);
      if (shouldApplyRelayoutScroll(scrollTop.value, nextScrollTop)) {
        scrollTop.value = nextScrollTop;
        scrollRef.current?.scrollTo({ y: nextScrollTop, animated: false });
      }
    }
    previousModelRef.current = model;
  }, [model, scrollTop]);
  useLayoutEffect(() => {
    horizontalOffsets.value = retainHorizontalOffsetsForPaths(
      horizontalOffsets.value,
      model.files.map((file) => file.path),
    );
  }, [horizontalOffsets, model.files]);

  const mode = props.mode;
  const collapsedFilePaths = props.collapsedFilePaths;
  const onToggleFile = props.onToggleFile;
  useEffect(() => {
    if (mode.kind !== "working") return;
    const focusPath = mode.focusPath;
    if (!focusPath) return;
    const requestKey = `${mode.focusRequestId ?? "initial"}:${focusPath}`;
    if (consumedFocusRef.current === requestKey) return;
    if (collapsedFilePaths.has(focusPath)) onToggleFile(focusPath);
    const file = model.files.find((entry) => entry.path === focusPath);
    if (file) {
      scrollTop.value = file.top;
      scrollRef.current?.scrollTo({ y: file.top, animated: false });
      consumedFocusRef.current = requestKey;
    }
  }, [collapsedFilePaths, mode, model.files, onToggleFile, scrollTop]);
  const contentInsetBottom = props.contentInsetBottom ?? 0;
  const contentStyle = useMemo(
    () => ({
      minHeight: Math.max(model.height, viewport.height) + contentInsetBottom,
      backgroundColor: "transparent",
    }),
    [contentInsetBottom, model.height, viewport.height],
  );
  // While a drag runs, a finger near the top or bottom edge scrolls the list each
  // frame and re-dispatches the drag at its unchanged viewport position, which is
  // a new document point after the scroll. The selection reducer runs on the JS
  // thread, so the tick does too. Programmatic scrolling ignores scrollEnabled.
  const autoScrollFrame = useStableEvent((elapsedMs: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = nextSelectionAutoScrollTop({
      viewportY: selectionDragViewportY(drag.pointer),
      viewportHeight: viewport.height,
      scrollTop: scrollTop.value,
      maxScrollTop: contentStyle.minHeight - viewport.height,
      elapsedMs,
    });
    if (next === null) return;
    scrollTop.value = next;
    scrollRef.current?.scrollTo({ y: next, animated: false });
    dispatchSelectionDrag(drag.pointer);
  });
  useEffect(() => {
    if (!selectionDragActive) return undefined;
    let frame = 0;
    let previousTime: number | null = null;
    const tick = (time: number) => {
      if (previousTime !== null) autoScrollFrame(time - previousTime);
      previousTime = time;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [autoScrollFrame, selectionDragActive]);
  return (
    <View style={[styles.root, { backgroundColor: props.palette.surface }]} onLayout={layout}>
      <AnimatedScrollView
        ref={scrollRef}
        style={[StyleSheet.absoluteFill, styles.scroll]}
        contentContainerStyle={contentStyle}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        scrollEnabled={!selectionDragActive}
        // With the editor's soft keyboard up, the first tap on Cancel must press it rather than
        // only dismissing the keyboard.
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        testID="git-diff-scroll"
        onTouchStart={outsideTouchStart}
        onTouchMove={outsideTouchMove}
        onTouchEnd={outsideTouchEnd}
        onTouchCancel={outsideTouchCancel}
      >
        <NativeCanvasSlabLayer
          model={model}
          viewportHeight={viewport.height}
          scrollTop={scrollTop}
          textLayout={textLayout}
          paints={paints}
          horizontalOffsets={horizontalOffsets}
          selectionGeometry={selection.geometry}
          selectionColor={props.palette.selection}
        />
        {interactionFiles.map((file) => (
          <NativeCanvasFileHeader
            key={`${file.path}:header`}
            file={file}
            viewportWidth={model.viewportWidth}
            scrollTop={scrollTop}
            textLayout={headerTextLayout}
            paints={paints}
            headerSurface={props.palette.headerSurface}
            headerActiveSurface={props.palette.headerActiveSurface}
            selectedPath={props.selectedPath}
            mode={props.mode}
            onToggleFile={props.onToggleFile}
            onSelectPath={props.onSelectPath}
          />
        ))}
        {interactionFiles.map((file) => (
          <NativeFileBody
            key={`${file.path}:body`}
            file={file}
            model={model}
            mode={props.mode}
            horizontalOffsets={horizontalOffsets}
            scrollEnabled={!selectionDragActive}
            onSelectionGesture={dispatchSelectionGesture}
            selectionDrag={selectionDrag}
          />
        ))}
        <NativeSelectionHandles
          model={model}
          selection={selection.selection}
          horizontalOffsets={horizontalOffsets}
          color={props.palette.selection}
          onSelectionGesture={dispatchSelectionGesture}
          selectionDrag={selectionDrag}
        />
        <NativeReviewOverlays model={model} mode={props.mode} />
        <Animated.View pointerEvents="none" style={keyboardSpacerStyle} />
      </AnimatedScrollView>
      {selectionDragActive ? null : (
        <NativeSelectionActionBar
          model={model}
          selection={selection.selection}
          scrollTop={scrollTop}
          horizontalOffsets={horizontalOffsets}
          viewport={viewport}
          palette={props.palette}
          onCopy={copySelection}
          onSelectAll={selectAllText}
        />
      )}
    </View>
  );
}

function NativeCanvasSlabLayer({
  model,
  viewportHeight,
  scrollTop,
  textLayout,
  paints,
  horizontalOffsets,
  selectionGeometry,
  selectionColor,
}: {
  model: DiffDocumentModel;
  viewportHeight: number;
  scrollTop: SharedValue<number>;
  textLayout: NativeTextLayout;
  paints: NativePaints;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  selectionGeometry: NativeSelectionGeometry | null;
  selectionColor: string;
}) {
  const [windowTop, setWindowTop] = useState(0);
  const updateWindow = useCallback((nextTop: number) => {
    setWindowTop((current) => (current === nextTop ? current : nextTop));
  }, []);
  useAnimatedReaction(
    () => nativeCanvasWindowBucket(scrollTop.value, viewportHeight),
    (bucket, previous) => {
      if (bucket !== previous) {
        scheduleOnRN(updateWindow, nativeCanvasWindowTop(bucket, viewportHeight));
      }
    },
    [updateWindow, viewportHeight],
  );
  const descriptors = useMemo(
    () => buildNativeCanvasSlabs(model, viewportHeight),
    [model, viewportHeight],
  );
  const visible = useMemo(
    () => nativeCanvasSlabsForViewport(descriptors, windowTop, viewportHeight),
    [descriptors, viewportHeight, windowTop],
  );
  if (model.viewportWidth <= 0 || viewportHeight <= 0) return null;
  return visible.map((slab) => (
    <NativeCanvasSlabView
      key={slab.key}
      slab={slab}
      model={model}
      textLayout={textLayout}
      paints={paints}
      horizontalOffsets={horizontalOffsets}
      selectionGeometry={selectionGeometry}
      selectionColor={selectionColor}
    />
  ));
}

function NativeCanvasFileHeader({
  file,
  viewportWidth,
  scrollTop,
  textLayout,
  paints,
  headerSurface,
  headerActiveSurface,
  selectedPath,
  mode,
  onToggleFile,
  onSelectPath,
}: {
  file: DiffFileSection;
  viewportWidth: number;
  scrollTop: SharedValue<number>;
  textLayout: NativeHeaderTextLayout;
  paints: NativePaints;
  headerSurface: string;
  headerActiveSurface: string;
  selectedPath: DiffSurfaceProps["selectedPath"];
  mode: DiffSurfaceProps["mode"];
  onToggleFile: DiffSurfaceProps["onToggleFile"];
  onSelectPath: DiffSurfaceProps["onSelectPath"];
}) {
  const [active, setActive] = useState(false);
  const picture = useMemo(
    () => recordNativeHeaderPicture({ file, viewportWidth, textLayout, paints }),
    [file, paints, textLayout, viewportWidth],
  );
  const { top, bottom, headerHeight } = file;
  const stickyStyle = useAnimatedStyle(() => {
    const pinOffset = Math.max(0, scrollTop.value - top);
    const maximumPinOffset = Math.max(0, bottom - headerHeight - top);
    return { transform: [{ translateY: Math.min(pinOffset, maximumPinOffset) }] };
  }, [bottom, headerHeight, top, scrollTop]);
  const style = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: file.top,
      left: 0,
      width: viewportWidth,
      height: file.headerHeight,
      backgroundColor: active ? headerActiveSurface : headerSurface,
      zIndex: 5,
      elevation: 2,
    }),
    [active, file.headerHeight, file.top, headerActiveSurface, headerSurface, viewportWidth],
  );
  return (
    <Animated.View style={[style, stickyStyle]}>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Picture picture={picture} />
      </Canvas>
      <DocumentFileHeader
        file={file}
        selectedPath={selectedPath}
        mode={mode}
        onToggleFile={onToggleFile}
        onSelectPath={onSelectPath}
        canvasRendered
        onActiveChange={setActive}
      />
    </Animated.View>
  );
}

function NativeFileBody({
  file,
  model,
  mode,
  horizontalOffsets,
  scrollEnabled,
  onSelectionGesture,
  selectionDrag,
}: {
  file: DiffFileSection;
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  scrollEnabled: boolean;
  onSelectionGesture: SelectionGestureDispatch;
  selectionDrag: SelectionDragControls;
}) {
  const reviewActions = mode.kind === "working" ? mode.reviewActions : undefined;
  const touchStart = useCallback(
    (event: GestureResponderEvent) => {
      onSelectionGesture({
        type: "touch-start",
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
        time: Date.now(),
      });
    },
    [onSelectionGesture],
  );
  const touchMove = useCallback(
    (event: GestureResponderEvent) => {
      onSelectionGesture({
        type: "touch-move",
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
      });
    },
    [onSelectionGesture],
  );
  const touchEnd = useCallback(
    (event: GestureResponderEvent) => {
      // A quick tap dismisses a selection; without one it opens a review comment.
      const effect = onSelectionGesture({ type: "touch-end", time: Date.now() });
      if (effect !== "comment" || !reviewActions) return;
      const hit = hitTestDiffBodyPoint({
        model,
        file,
        locationX: event.nativeEvent.locationX,
        locationY: event.nativeEvent.locationY,
        horizontalOffset: horizontalOffsetForPath(horizontalOffsets.value, file.path),
      });
      if (hit?.kind === "cell" && hit.target) reviewActions.onStartComment(hit.target);
    },
    [file, horizontalOffsets, model, onSelectionGesture, reviewActions],
  );
  const touchCancel = useCallback(
    () => onSelectionGesture({ type: "touch-cancel" }),
    [onSelectionGesture],
  );
  // The body's x/y move with the content, so drags track the absolute movement since
  // the press instead; auto-scroll then adds the scroll offset to that viewport point.
  const pressAbsoluteRef = useRef({ x: 0, y: 0 });
  const longPressStart = useStableEvent(
    (locationX: number, locationY: number, absoluteX: number, absoluteY: number) => {
      pressAbsoluteRef.current = { x: absoluteX, y: absoluteY };
      selectionDrag.beginLongPress(file.fileIndex, locationX, locationY);
      onSelectionGesture({ type: "long-press", point: { file, locationX, locationY } });
    },
  );
  const longPressDrag = useStableEvent((absoluteX: number, absoluteY: number) => {
    const press = pressAbsoluteRef.current;
    selectionDrag.move("long-press", absoluteX - press.x, absoluteY - press.y);
  });
  const longPressEnd = useStableEvent(() => {
    selectionDrag.end("long-press");
    onSelectionGesture({ type: "drag-end", source: "long-press" });
  });
  // Fails if the finger moves before the hold completes, so scrolling and panel
  // swipes win; once active it cancels them for the rest of the touch.
  const longPress = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activateAfterLongPress(SELECTION_LONG_PRESS_MS)
        .onStart((event) => longPressStart(event.x, event.y, event.absoluteX, event.absoluteY))
        .onUpdate((event) => longPressDrag(event.absoluteX, event.absoluteY))
        .onFinalize(() => longPressEnd()),
    [longPressDrag, longPressEnd, longPressStart],
  );
  return (
    <GestureDetector gesture={longPress}>
      <View
        testID={`diff-file-${file.fileIndex}-body`}
        style={inlineUnistylesStyle<ViewStyle>({
          position: "absolute",
          top: file.bodyTop,
          left: 0,
          right: 0,
          height: file.bodyHeight,
          zIndex: 2,
        })}
        onTouchStart={touchStart}
        onTouchMove={touchMove}
        onTouchEnd={touchEnd}
        onTouchCancel={touchCancel}
      >
        {!file.isCollapsed && !model.wrapLines ? (
          <HorizontalScroll file={file} offsets={horizontalOffsets} scrollEnabled={scrollEnabled} />
        ) : null}
      </View>
    </GestureDetector>
  );
}

function NativeSelectionHandles({
  model,
  selection,
  horizontalOffsets,
  color,
  onSelectionGesture,
  selectionDrag,
}: {
  model: DiffDocumentModel;
  selection: DiffSelection | null;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  color: string;
  onSelectionGesture: SelectionGestureDispatch;
  selectionDrag: SelectionDragControls;
}) {
  const carets = useMemo(() => nativeSelectionCarets(model, selection), [model, selection]);
  if (!carets) return null;
  return (
    <>
      <NativeSelectionHandle
        handle="start"
        caret={carets.start}
        horizontalOffsets={horizontalOffsets}
        color={color}
        onSelectionGesture={onSelectionGesture}
        selectionDrag={selectionDrag}
      />
      <NativeSelectionHandle
        handle="end"
        caret={carets.end}
        horizontalOffsets={horizontalOffsets}
        color={color}
        onSelectionGesture={onSelectionGesture}
        selectionDrag={selectionDrag}
      />
    </>
  );
}

function NativeSelectionHandle({
  handle,
  caret,
  horizontalOffsets,
  color,
  onSelectionGesture,
  selectionDrag,
}: {
  handle: SelectionHandle;
  caret: NativeSelectionCaret;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  color: string;
  onSelectionGesture: SelectionGestureDispatch;
  selectionDrag: SelectionDragControls;
}) {
  // The drag starts at the caret's middle; the surface adds the pan's translation
  // and any auto-scroll since then.
  const begin = useStableEvent(() => {
    selectionDrag.beginHandle(caret);
    onSelectionGesture({ type: "handle-start", handle });
  });
  const drag = useStableEvent((translationX: number, translationY: number) =>
    selectionDrag.move("handle", translationX, translationY),
  );
  const end = useStableEvent(() => {
    selectionDrag.end("handle");
    onSelectionGesture({ type: "drag-end", source: "handle" });
  });
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onStart(() => begin())
        .onUpdate((event) => drag(event.translationX, event.translationY))
        .onFinalize(() => end()),
    [begin, drag, end],
  );
  // Follows horizontal scroll on the UI thread; vertical scroll moves it with the content.
  const positionStyle = useAnimatedStyle(() => {
    const viewportX = nativeCaretViewportX(caret, horizontalOffsets.value);
    const visible = viewportX >= caret.clipX && viewportX <= caret.clipX + caret.clipWidth;
    return {
      opacity: visible ? 1 : 0,
      transform: [{ translateX: visible ? viewportX - HANDLE_HIT_SIZE / 2 : HIDDEN_HANDLE_X }],
    };
  }, [caret, horizontalOffsets]);
  const frameStyle = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: caret.top,
      left: 0,
      width: HANDLE_HIT_SIZE,
      height: caret.height + HANDLE_HIT_SIZE,
      zIndex: 4,
    }),
    [caret.height, caret.top],
  );
  const stemStyle = useMemo<ViewStyle>(
    () => ({ height: caret.height, backgroundColor: color }),
    [caret.height, color],
  );
  const knobStyle = useMemo<ViewStyle>(
    () => ({ top: caret.height, backgroundColor: color }),
    [caret.height, color],
  );
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        testID={`git-diff-selection-handle-${handle}`}
        style={[frameStyle, positionStyle]}
        onTouchStart={selectionDrag.claimTouch}
      >
        <View pointerEvents="none" style={[styles.handleStem, stemStyle]} />
        <View pointerEvents="none" style={[styles.handleKnob, knobStyle]} />
      </Animated.View>
    </GestureDetector>
  );
}

function NativeSelectionActionBar({
  model,
  selection,
  scrollTop,
  horizontalOffsets,
  viewport,
  palette,
  onCopy,
  onSelectAll,
}: {
  model: DiffDocumentModel;
  selection: DiffSelection | null;
  scrollTop: SharedValue<number>;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  viewport: { width: number; height: number };
  palette: DiffSurfaceProps["palette"];
  onCopy: () => void;
  onSelectAll: () => void;
}) {
  const { t } = useTranslation();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const carets = useMemo(() => nativeSelectionCarets(model, selection), [model, selection]);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current?.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  // Follows both scroll axes on the UI thread; hidden until measured or while out of view.
  const positionStyle = useAnimatedStyle(() => {
    const placement =
      carets && size
        ? placeSelectionActionBar({
            start: {
              x: nativeCaretViewportX(carets.start, horizontalOffsets.value),
              top: carets.start.top,
              bottom: carets.start.top + carets.start.height,
            },
            end: {
              x: nativeCaretViewportX(carets.end, horizontalOffsets.value),
              top: carets.end.top,
              bottom: carets.end.top + carets.end.height,
            },
            endHandleHeight: HANDLE_KNOB_SIZE,
            scrollTop: scrollTop.value,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            barWidth: size.width,
            barHeight: size.height,
          })
        : null;
    if (!placement) {
      return { opacity: 0, transform: [{ translateX: HIDDEN_HANDLE_X }, { translateY: 0 }] };
    }
    return {
      opacity: 1,
      transform: [{ translateX: placement.left }, { translateY: placement.top }],
    };
  }, [carets, horizontalOffsets, scrollTop, size, viewport.height, viewport.width]);
  const barStyle = useMemo<ViewStyle>(
    () => ({ backgroundColor: palette.headerSurface, borderColor: palette.border }),
    [palette.border, palette.headerSurface],
  );
  const dividerStyle = useMemo<ViewStyle>(
    () => ({ backgroundColor: palette.border }),
    [palette.border],
  );
  if (!carets) return null;
  const copyLabel = t("common.actions.copy");
  const selectAllLabel = t("common.actions.selectAll");
  return (
    <Animated.View
      testID="git-diff-selection-actions"
      onLayout={measure}
      style={[styles.actionBar, barStyle, positionStyle]}
    >
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={copyLabel}
        testID="git-diff-selection-copy"
        onPress={onCopy}
      >
        {copyLabel}
      </Button>
      <View style={[styles.actionDivider, dividerStyle]} />
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={selectAllLabel}
        testID="git-diff-selection-select-all"
        onPress={onSelectAll}
      >
        {selectAllLabel}
      </Button>
    </Animated.View>
  );
}

function NativeReviewOverlays({
  model,
  mode,
}: {
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
}) {
  if (mode.kind !== "working" || !mode.reviewActions) return null;
  const reviewActions = mode.reviewActions;
  return model.rows.flatMap((row) => {
    if (row.kind !== "line" || row.reviewHeight === 0) return [];
    return row.cells.flatMap((cell, index) => {
      if (!cell?.reviewTarget) return [];
      const comments = reviewActions.commentsByTarget.get(cell.reviewTarget.key) ?? [];
      const editor = reviewActions.editor;
      const hasEditor =
        editor?.target.filePath === cell.reviewTarget.filePath &&
        editor.target.side === cell.reviewTarget.side &&
        editor.target.lineNumber === cell.reviewTarget.lineNumber;
      if (comments.length === 0 && !hasEditor) return [];
      const frame = resolveReviewOverlayFrame({
        viewportWidth: model.viewportWidth,
        columnCount: row.cells.length,
        columnIndex: index,
        rowHeight: row.reviewHeight,
        leftHeight:
          getInlineReviewThreadState({ reviewTarget: row.cells[0]?.reviewTarget, reviewActions })
            ?.height ?? 0,
      });
      return [
        <View
          key={cell.reviewTarget.key}
          style={inlineUnistylesStyle<ViewStyle>({
            position: "absolute",
            top: row.top + row.height - row.reviewHeight + frame.top,
            left: frame.left,
            width: frame.width,
            height: frame.height,
            zIndex: 6,
          })}
        >
          <InlineReviewThread
            reviewTarget={cell.reviewTarget}
            reviewActions={reviewActions}
            height={frame.height}
            viewportWidth={frame.width}
            pinToViewport={!model.wrapLines}
          />
        </View>,
      ];
    });
  });
}

function NativeCanvasSlabView({
  slab,
  model,
  textLayout,
  paints,
  horizontalOffsets,
  selectionGeometry,
  selectionColor,
}: {
  slab: NativeCanvasSlab;
  model: DiffDocumentModel;
  textLayout: NativeTextLayout;
  paints: NativePaints;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  selectionGeometry: NativeSelectionGeometry | null;
  selectionColor: string;
}) {
  const file = model.files[slab.fileIndex];
  const pictures = useMemo(
    () =>
      recordNativeSlabPictures({
        model,
        fileIndex: slab.fileIndex,
        top: slab.top,
        height: slab.height,
        viewportWidth: model.viewportWidth,
        textLayout,
        paints,
      }),
    [model, paints, slab.fileIndex, slab.height, slab.top, textLayout],
  );
  const selectionRects = useMemo(
    () => nativeSelectionRectsForSlab(selectionGeometry, slab),
    [selectionGeometry, slab],
  );
  const style = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: slab.top,
      left: 0,
      right: 0,
      height: slab.height,
      zIndex: 3,
    }),
    [slab.height, slab.top],
  );
  if (!file) return null;
  const unifiedClip = {
    x: file.gutterWidth + CODE_LEFT_PADDING,
    width: model.viewportWidth - file.gutterWidth - CODE_LEFT_PADDING,
  };
  const columnWidth = model.viewportWidth / 2;
  const splitClipWidth = columnWidth - file.gutterWidth - CODE_LEFT_PADDING;
  return (
    <View pointerEvents="none" style={style} testID={`git-diff-canvas-${slab.key}`}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Picture picture={pictures.fixed} />
      </Canvas>
      <NativeSlabCode
        picture={pictures.content.unified}
        selectionRects={selectionRects.unified}
        selectionColor={selectionColor}
        path={slab.path}
        horizontalOffsets={horizontalOffsets}
        wrapLines={model.wrapLines}
        clipX={unifiedClip.x}
        clipWidth={unifiedClip.width}
        height={slab.height}
      />
      {model.layout === "split" ? (
        <>
          <NativeSlabCode
            picture={pictures.content.left}
            selectionRects={selectionRects.left}
            selectionColor={selectionColor}
            path={slab.path}
            horizontalOffsets={horizontalOffsets}
            wrapLines={model.wrapLines}
            clipX={file.gutterWidth + CODE_LEFT_PADDING}
            clipWidth={splitClipWidth}
            height={slab.height}
          />
          <NativeSlabCode
            picture={pictures.content.right}
            selectionRects={selectionRects.right}
            selectionColor={selectionColor}
            path={slab.path}
            horizontalOffsets={horizontalOffsets}
            wrapLines={model.wrapLines}
            clipX={columnWidth + file.gutterWidth + CODE_LEFT_PADDING}
            clipWidth={splitClipWidth}
            height={slab.height}
          />
        </>
      ) : null}
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Picture picture={pictures.gutter} />
      </Canvas>
    </View>
  );
}

function NativeSlabCode({
  picture,
  selectionRects,
  selectionColor,
  path,
  horizontalOffsets,
  wrapLines,
  clipX,
  clipWidth,
  height,
}: {
  picture: SkPicture;
  selectionRects: readonly NativeSelectionRect[];
  selectionColor: string;
  path: string;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  wrapLines: boolean;
  clipX: number;
  clipWidth: number;
  height: number;
}) {
  const pictureTransform = useDerivedValue(() => [
    {
      translateX: -clipX - (wrapLines ? 0 : horizontalOffsetForPath(horizontalOffsets.value, path)),
    },
  ]);
  const clipStyle = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: 0,
      left: clipX,
      width: clipWidth,
      height,
      overflow: "hidden",
    }),
    [clipWidth, clipX, height],
  );
  if (clipWidth <= 0 || height <= 0) return null;
  return (
    <View pointerEvents="none" style={clipStyle}>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Group transform={pictureTransform}>
          {selectionRects.length > 0 ? (
            <Group opacity={SELECTION_OPACITY}>
              {selectionRects.map((rect) => (
                <Rect
                  key={`${rect.x}:${rect.y}`}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  color={selectionColor}
                />
              ))}
            </Group>
          ) : null}
          <Picture picture={picture} />
        </Group>
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden" },
  scroll: { backgroundColor: "transparent" },
  handleStem: {
    position: "absolute",
    top: 0,
    left: (HANDLE_HIT_SIZE - HANDLE_STEM_WIDTH) / 2,
    width: HANDLE_STEM_WIDTH,
  },
  handleKnob: {
    position: "absolute",
    left: (HANDLE_HIT_SIZE - HANDLE_KNOB_SIZE) / 2,
    width: HANDLE_KNOB_SIZE,
    height: HANDLE_KNOB_SIZE,
    borderRadius: HANDLE_KNOB_SIZE / 2,
  },
  actionBar: {
    position: "absolute",
    top: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    padding: 4,
    gap: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    zIndex: 10,
    elevation: 6,
  },
  actionDivider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch" },
});

function noop(): void {}
