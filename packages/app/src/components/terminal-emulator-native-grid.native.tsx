import Svg, { Path } from "react-native-svg";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  type LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { ITheme } from "@xterm/xterm";
import {
  TerminalInputModeTracker,
  terminalInputModeStatesEqual,
  type TerminalInputModeState,
} from "@getpaseo/protocol/terminal-input-mode";
import type { TerminalEmulatorHandle, TerminalEmulatorProps } from "./terminal-emulator-contract";
import {
  createNativeHeadlessTerminal,
  type NativeHeadlessTerminal,
  type TerminalViewportState,
} from "../terminal/native-renderer/headless-terminal-state";
import {
  createNativeTerminalOutputDrain,
  type NativeTerminalOutputDrain,
} from "../terminal/native-renderer/headless-terminal-output-drain";
import { traceTerminalLatency } from "../terminal/native-renderer/terminal-input-trace";
import { TerminalGridView } from "../terminal/native-renderer/terminal-grid-view.native";
import type { TerminalGridCellMetrics } from "../terminal/native-renderer/terminal-grid-metrics";
import {
  createNativeTerminalScreenModel,
  type TerminalScreenModel,
  type TerminalScreenState,
} from "../terminal/native-renderer/terminal-screen-model";
import {
  copyTerminalSelection,
  createTerminalSelectionModel,
  hitTestTerminalSelectionCell,
  resolveTerminalWordSelection,
  type TerminalBufferCoordinate,
  type TerminalClipboardWriter,
  type TerminalSelectionModel,
  type TerminalSelectionRange,
  type TerminalSelectionViewport,
} from "../terminal/native-renderer/terminal-selection";
import {
  createTerminalSelectionController,
  terminalSelectionHandles,
  TERMINAL_SELECTION_GRIP_SIZE,
} from "../terminal/native-renderer/terminal-selection-controller";
import { resolveNativeTerminalMountAction } from "../terminal/native-renderer/terminal-mount-policy";
import {
  forwardNativeTerminalKey,
  type NativeTerminalKeyEvent,
} from "../terminal/native-renderer/terminal-key-events";
import {
  TerminalInput,
  type TerminalInputHandle,
} from "../terminal/native-renderer/terminal-input.native";
import {
  shouldClaimNativeTerminalSize,
  type NativeTerminalSizeClaimAction,
} from "../terminal/native-renderer/terminal-input-resize-policy";
import { encodeTerminalPaste } from "../terminal/runtime/terminal-paste";
import type {
  TerminalFindHandle,
  TerminalOutputData,
} from "../terminal/runtime/terminal-emulator-runtime";
import {
  createTerminalFindController,
  type TerminalFindState,
} from "../terminal/native-renderer/terminal-find-controller";
import {
  createTerminalResizePolicy,
  updateTerminalResizePolicy,
  type TerminalResizeSource,
} from "../terminal/native-renderer/terminal-resize-policy";
import {
  resolveMeasuredNativeTerminalSize,
  type TerminalMeasuredLayout,
  type TerminalMeasuredSize,
} from "../terminal/native-renderer/terminal-size-measurement";

const MIN_NATIVE_TERMINAL_ROWS = 1;
const MIN_NATIVE_TERMINAL_COLS = 1;
const DEFAULT_XTERM_THEME: ITheme = {
  background: "#0b0b0b",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
};
const FIND_DEBOUNCE_MS = 150;

function initialNativeTerminalSize(): TerminalMeasuredSize {
  return { rows: MIN_NATIVE_TERMINAL_ROWS, cols: MIN_NATIVE_TERMINAL_COLS };
}

function NativeTerminalEmulator({
  ref,
  streamKey,
  testId = "terminal-surface",
  xtermTheme = DEFAULT_XTERM_THEME,
  scrollbackLines,
  characterWidths,
  fontFamily,
  fontSize,
  keyboardInset = 0,
  isKeyboardVisible = false,
  onInput,
  onTerminalKey,
  onResize,
  onInputModeChange,
  onSelectionChange,
  onRendererReadyChange,
  onFocus,
  onFindResult,
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const terminalRef = useRef<NativeHeadlessTerminal | null>(null);
  const mountInputRef = useRef({ streamKey });
  if (
    resolveNativeTerminalMountAction({
      mountedStreamKey: mountInputRef.current.streamKey,
      nextStreamKey: streamKey,
    }) === "mount"
  ) {
    mountInputRef.current = { streamKey };
  }
  const inputRef = useRef<TerminalInputHandle>(null);
  const terminalSizeRef = useRef<TerminalMeasuredSize>(initialNativeTerminalSize());
  const resizePolicyRef = useRef(createTerminalResizePolicy(initialNativeTerminalSize()));
  const activeResizeClaimTokenRef = useRef(0);
  const layoutRef = useRef<TerminalMeasuredLayout | null>(null);
  const metricsRef = useRef<TerminalGridCellMetrics | null>(null);
  const hasNotifiedMeasuredSizeRef = useRef(false);
  const outputDrainRef = useRef<NativeTerminalOutputDrain | null>(null);
  const screenModelRef = useRef<TerminalScreenModel | null>(null);
  const selectionModelRef = useRef<TerminalSelectionModel>(createTerminalSelectionModel());
  const selectionControllerRef = useRef<ReturnType<
    typeof createTerminalSelectionController
  > | null>(null);
  const gestureStartRef = useRef({ x: 0, y: 0 });
  const [cellMetrics, setCellMetrics] = useState<TerminalGridCellMetrics | null>(null);
  const latestResolvedScreenRef = useRef<TerminalScreenState | null>(null);
  const paintFrameRef = useRef<number | null>(null);
  const outputDecoderRef = useRef(new TextDecoder());
  const inputModeTrackerRef = useRef(new TerminalInputModeTracker());
  const lastInputModeStateRef = useRef<TerminalInputModeState>({
    ...inputModeTrackerRef.current.getState(),
    applicationCursorKeys: false,
  });
  const [terminalScreen, setTerminalScreen] = useState<TerminalScreenState | null>(null);
  const [selectionRange, setSelectionRange] = useState<TerminalSelectionRange | null>(null);
  const selectionRangeRef = useRef<TerminalSelectionRange | null>(null);
  const hasNotifiedSelectionRef = useRef(false);
  const terminalScreenRef = useRef<TerminalScreenState | null>(terminalScreen);
  const callbacksRef = useRef({
    onFocus,
    onInput,
    onTerminalKey,
    onInputModeChange,
    onSelectionChange,
    onRendererReadyChange,
    onResize,
    onFindResult,
  });
  callbacksRef.current = {
    onFocus,
    onInput,
    onTerminalKey,
    onInputModeChange,
    onSelectionChange,
    onRendererReadyChange,
    onResize,
    onFindResult,
  };
  // Bumped on every write so find rescans only after output changed the buffer.
  const writeRevisionRef = useRef(0);
  const findControllerRef = useRef<ReturnType<typeof createTerminalFindController> | null>(null);
  const findBarHeightRef = useRef(0);
  const findDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [findState, setFindState] = useState<TerminalFindState | null>(null);

  const getInputModeState = useCallback((): TerminalInputModeState => {
    return inputModeTrackerRef.current.getState();
  }, []);

  const emitInputModeChange = useCallback(() => {
    const state = getInputModeState();
    if (terminalInputModeStatesEqual(state, lastInputModeStateRef.current)) {
      return;
    }
    lastInputModeStateRef.current = state;
    callbacksRef.current.onInputModeChange?.(state);
  }, [getInputModeState]);

  const resetInputModeTracker = useCallback(() => {
    inputModeTrackerRef.current.reset();
    emitInputModeChange();
  }, [emitInputModeChange]);

  const commitTerminalScreen = useCallback((screen: TerminalScreenState) => {
    latestResolvedScreenRef.current = screen;
    terminalScreenRef.current = screen;
    setTerminalScreen(screen);
  }, []);

  const commitSelectionRange = useCallback((range: TerminalSelectionRange | null) => {
    selectionRangeRef.current = range;
    const hasSelection = range !== null;
    if (hasNotifiedSelectionRef.current !== hasSelection) {
      hasNotifiedSelectionRef.current = hasSelection;
      callbacksRef.current.onSelectionChange?.(hasSelection);
    }
    setSelectionRange((current) => {
      if (current === range) {
        return current;
      }
      return range;
    });
  }, []);

  const clearSelection = useCallback(() => {
    selectionControllerRef.current?.cancel();
    const snapshot = selectionModelRef.current.clear();
    commitSelectionRange(snapshot.range);
  }, [commitSelectionRange]);

  useEffect(() => {
    terminalScreenRef.current = terminalScreen;
  }, [terminalScreen]);

  const syncSelectionWithTerminal = useCallback(
    (terminal: NativeHeadlessTerminal) => {
      const previous = selectionModelRef.current.getSnapshot().range;
      const snapshot = selectionModelRef.current.sync({ bounds: terminal.getBufferBounds() });
      if (previous && !snapshot.range) selectionControllerRef.current?.cancel();
      commitSelectionRange(snapshot.range);
    },
    [commitSelectionRange],
  );

  const resolveVisibleRows = useCallback((terminal: NativeHeadlessTerminal): number => {
    return (
      resolveMeasuredNativeTerminalSize({
        layout: layoutRef.current,
        metrics: metricsRef.current,
      })?.rows ?? terminal.getBufferBounds().rows
    );
  }, []);

  const resolveTerminalScreen = useCallback(
    (terminal: NativeHeadlessTerminal): TerminalScreenState => {
      if (!screenModelRef.current) {
        screenModelRef.current = createNativeTerminalScreenModel({ terminal });
      }
      const screen = screenModelRef.current.sync({ visibleRows: resolveVisibleRows(terminal) });
      latestResolvedScreenRef.current = screen;
      return screen;
    },
    [resolveVisibleRows],
  );

  const paintTerminalScreen = useCallback(
    (terminal: NativeHeadlessTerminal): TerminalViewportState => {
      const screen = resolveTerminalScreen(terminal);
      commitTerminalScreen(screen);
      syncSelectionWithTerminal(terminal);
      return screen.viewport;
    },
    [commitTerminalScreen, resolveTerminalScreen, syncSelectionWithTerminal],
  );

  const schedulePaint = useCallback(() => {
    if (paintFrameRef.current !== null) {
      return;
    }
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      paintTerminalScreen(terminal);
    });
  }, [paintTerminalScreen]);

  const createOutputDrain = useCallback(
    (terminal: NativeHeadlessTerminal): NativeTerminalOutputDrain =>
      createNativeTerminalOutputDrain({
        write: async (chunk) => {
          inputModeTrackerRef.current.feed(chunk);
          await terminal.write(chunk);
          writeRevisionRef.current += 1;
          emitInputModeChange();
        },
        restoreSize: () => terminal.resize(terminalSizeRef.current),
        reset: (size) => {
          inputModeTrackerRef.current.reset();
          if (size) terminal.resize(size);
          terminal.reset();
          writeRevisionRef.current += 1;
          emitInputModeChange();
        },
        getViewportState: () => {
          const screen = resolveTerminalScreen(terminal);
          syncSelectionWithTerminal(terminal);
          return screen.viewport;
        },
        onParse: (sample) => {
          traceTerminalLatency("parsed", sample.parsedChars);
        },
        onPaint: () => {
          traceTerminalLatency("paint", 0);
          const screen = latestResolvedScreenRef.current;
          if (screen) {
            commitTerminalScreen(screen);
          }
        },
        scheduleFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
      }),
    [commitTerminalScreen, emitInputModeChange, resolveTerminalScreen, syncSelectionWithTerminal],
  );

  const emitMeasuredSize = useCallback(
    (input: { source: TerminalResizeSource; claimToken?: number }) => {
      const nextSize = resolveMeasuredNativeTerminalSize({
        layout: layoutRef.current,
        metrics: metricsRef.current,
      });
      if (!nextSize) {
        if (input.source === "claim") {
          resizePolicyRef.current = updateTerminalResizePolicy(resizePolicyRef.current, {
            source: input.source,
            size: null,
            claimToken: input.claimToken,
          }).state;
        }
        return;
      }
      const policyResult = updateTerminalResizePolicy(resizePolicyRef.current, {
        source: input.source,
        size: nextSize,
        claimToken: input.claimToken,
      });
      resizePolicyRef.current = policyResult.state;
      if (
        !policyResult.measuredSizeChanged &&
        !policyResult.resizeClaim &&
        hasNotifiedMeasuredSizeRef.current
      ) {
        return;
      }

      const isFirstMeasuredSize = !hasNotifiedMeasuredSizeRef.current;
      hasNotifiedMeasuredSizeRef.current = true;
      terminalSizeRef.current = policyResult.measuredSize;
      if (policyResult.measuredSizeChanged) {
        outputDrainRef.current?.resize();
      }
      callbacksRef.current.onResize?.({
        rows: policyResult.measuredSize.rows,
        cols: policyResult.measuredSize.cols,
        shouldClaim: policyResult.resizeClaim !== null,
        forceClaim: policyResult.resizeClaim?.force,
      });
      // Ready waits for the grid size, so the pane attaches with it and the daemon replays the
      // terminal at that size instead of the PTY's.
      if (isFirstMeasuredSize) {
        callbacksRef.current.onRendererReadyChange?.({
          streamKey: mountInputRef.current.streamKey,
          isReady: true,
        });
      }
    },
    [],
  );

  const resetTerminal = useCallback(() => {
    outputDrainRef.current?.dispose();
    outputDrainRef.current = null;
    terminalRef.current?.dispose();
    screenModelRef.current = null;
    latestResolvedScreenRef.current = null;
    clearSelection();
    const measuredSize = resolveMeasuredNativeTerminalSize({
      layout: layoutRef.current,
      metrics: metricsRef.current,
    });
    const size = measuredSize ?? terminalSizeRef.current;
    terminalSizeRef.current = size;
    resizePolicyRef.current = createTerminalResizePolicy(size);
    outputDecoderRef.current.decode();
    const terminal = createNativeHeadlessTerminal({
      rows: size.rows,
      cols: size.cols,
      scrollbackLines,
      characterWidths,
    });
    terminalRef.current = terminal;
    findControllerRef.current = createTerminalFindController({
      search: (query) => terminal.search(query),
      revision: () => writeRevisionRef.current,
      coordinateEpoch: () => terminal.getBufferBounds().coordinateEpoch,
    });
    setFindState(null);
    screenModelRef.current = createNativeTerminalScreenModel({ terminal });
    const outputDrain = createOutputDrain(terminal);
    outputDrainRef.current = outputDrain;
    const screen = resolveTerminalScreen(terminal);
    commitTerminalScreen(screen);
    resetInputModeTracker();
  }, [
    commitTerminalScreen,
    createOutputDrain,
    resetInputModeTracker,
    resolveTerminalScreen,
    scrollbackLines,
    characterWidths,
    clearSelection,
  ]);

  const enqueueOutputText = useCallback((text: string) => {
    if (text.length === 0) {
      return;
    }
    traceTerminalLatency("recv", text.length);
    outputDrainRef.current?.enqueueText(text);
  }, []);

  // Shows a find result: centres the current match in the rows above the find bar and
  // reports the position the bar displays.
  const showFindState = useCallback(
    (state: TerminalFindState) => {
      setFindState(state);
      const terminal = terminalRef.current;
      const model = screenModelRef.current;
      const match = state.matches[state.current];
      if (terminal && model && match) {
        const cellHeight = metricsRef.current?.cellHeight ?? 0;
        const coveredRows = cellHeight > 0 ? Math.ceil(findBarHeightRef.current / cellHeight) : 0;
        commitTerminalScreen(
          model.scrollToRow({
            visibleRows: resolveVisibleRows(terminal),
            row: match.startRow,
            coveredRows,
          }),
        );
      }
      callbacksRef.current.onFindResult?.({
        resultIndex: state.current,
        resultCount: state.matches.length,
        limited: state.limited,
        placement: "bottom",
      });
    },
    [commitTerminalScreen, resolveVisibleRows],
  );

  const find = useMemo<TerminalFindHandle>(
    () => ({
      setWidgetSize: (size) => {
        findBarHeightRef.current = size.height;
      },
      search: (query, direction) => {
        const controller = findControllerRef.current;
        if (!controller) return;
        if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
        if (direction) {
          showFindState(controller.step(direction === "next" ? 1 : -1));
          return;
        }
        findDebounceRef.current = setTimeout(() => {
          findDebounceRef.current = null;
          const firstRow = terminalScreenRef.current?.viewport.firstRow ?? 0;
          showFindState(controller.search(query, firstRow));
        }, FIND_DEBOUNCE_MS);
      },
      clear: () => {
        if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
        findDebounceRef.current = null;
        findControllerRef.current?.clear();
        setFindState(null);
        callbacksRef.current.onFindResult?.({
          resultIndex: -1,
          resultCount: 0,
          limited: false,
          placement: "bottom",
        });
      },
    }),
    [showFindState],
  );
  useEffect(
    () => () => {
      if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
    },
    [],
  );

  const claimActiveTerminalSize = useCallback(() => {
    activeResizeClaimTokenRef.current += 1;
    emitMeasuredSize({ source: "claim", claimToken: activeResizeClaimTokenRef.current });
  }, [emitMeasuredSize]);

  const claimActiveTerminalSizeForAction = useCallback(
    (action: NativeTerminalSizeClaimAction) => {
      if (shouldClaimNativeTerminalSize(action)) {
        claimActiveTerminalSize();
      }
    },
    [claimActiveTerminalSize],
  );

  useImperativeHandle(
    ref,
    (): TerminalEmulatorHandle => ({
      find,
      writeOutput: (data: TerminalOutputData) => {
        const text = outputDecoderRef.current.decode(data, { stream: true });
        enqueueOutputText(text);
      },
      replay: (event) => outputDrainRef.current?.replay(event),
      paste: (text: string) => {
        if (text.length === 0) {
          return;
        }
        claimActiveTerminalSizeForAction("paste");
        callbacksRef.current.onInput?.(
          encodeTerminalPaste({
            text,
            bracketedPaste: inputModeTrackerRef.current.getState().bracketedPaste ?? false,
          }),
        );
      },
      copySelection: async (clipboard: TerminalClipboardWriter): Promise<string> => {
        const terminal = terminalRef.current;
        if (!terminal) {
          return "";
        }
        const selection = selectionModelRef.current.getSnapshot().range;
        const copied = await copyTerminalSelection({ terminal, selection, clipboard });
        if (copied.length > 0) {
          clearSelection();
        }
        return copied;
      },
      clear: () => {
        outputDecoderRef.current.decode();
        outputDrainRef.current?.clear();
        screenModelRef.current?.reset();
        clearSelection();
        resetInputModeTracker();
        schedulePaint();
      },
      claimSize: claimActiveTerminalSize,
      showKeyboard: () => {
        inputRef.current?.showKeyboard();
        claimActiveTerminalSizeForAction("showKeyboard");
      },
      blur: () => {
        inputRef.current?.blur();
        Keyboard.dismiss();
      },
    }),
    [
      find,
      enqueueOutputText,
      claimActiveTerminalSize,
      claimActiveTerminalSizeForAction,
      clearSelection,
      resetInputModeTracker,
      schedulePaint,
    ],
  );

  useEffect(() => {
    hasNotifiedMeasuredSizeRef.current = false;
    resetTerminal();
    emitMeasuredSize({ source: "measure" });
    return () => {
      callbacksRef.current.onRendererReadyChange?.({ streamKey, isReady: false });
      selectionControllerRef.current?.cancel();
      if (paintFrameRef.current !== null) {
        cancelAnimationFrame(paintFrameRef.current);
        paintFrameRef.current = null;
      }
      outputDrainRef.current?.dispose();
      outputDrainRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [emitMeasuredSize, resetTerminal, streamKey]);

  useEffect(() => {
    if (focusRequestToken <= 0) return;
    inputRef.current?.focus();
  }, [focusRequestToken]);

  const handleTerminalFocus = useCallback(() => {
    callbacksRef.current.onFocus?.();
    claimActiveTerminalSizeForAction("focus");
  }, [claimActiveTerminalSizeForAction]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      claimActiveTerminalSizeForAction("text");
      traceTerminalLatency("send", data.length);
      callbacksRef.current.onInput?.(data);
    },
    [claimActiveTerminalSizeForAction],
  );

  const handleNativeTerminalKey = useCallback(
    (event: NativeTerminalKeyEvent) => {
      claimActiveTerminalSizeForAction("key");
      traceTerminalLatency("send", 0);
      forwardNativeTerminalKey({ event, onTerminalKey: callbacksRef.current.onTerminalKey });
    },
    [claimActiveTerminalSizeForAction],
  );

  const focusTerminalFromTap = useCallback(() => {
    clearSelection();
    inputRef.current?.focus();
    claimActiveTerminalSizeForAction("focus");
  }, [claimActiveTerminalSizeForAction, clearSelection]);

  useEffect(() => {
    if (resizeRequestToken <= 0) return;
    emitMeasuredSize({ source: "measure" });
  }, [emitMeasuredSize, resizeRequestToken]);

  useEffect(() => {
    emitMeasuredSize({ source: "measure" });
  }, [emitMeasuredSize, keyboardInset]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      layoutRef.current = {
        width: event.nativeEvent.layout.width,
        height: event.nativeEvent.layout.height,
      };
      emitMeasuredSize({ source: "measure" });
    },
    [emitMeasuredSize],
  );

  const handleCellMetricsChange = useCallback(
    (metrics: TerminalGridCellMetrics) => {
      metricsRef.current = metrics;
      setCellMetrics(metrics);
      emitMeasuredSize({ source: "measure" });
    },
    [emitMeasuredSize],
  );

  const applyScroll = useCallback(
    (direction: "up" | "down", rows: number) => {
      const terminal = terminalRef.current;
      const model = screenModelRef.current;
      if (!terminal || !model || rows <= 0) {
        return;
      }
      const visibleRows = resolveVisibleRows(terminal);
      const screen =
        direction === "up"
          ? model.scrollUp({ rows, visibleRows })
          : model.scrollDown({ rows, visibleRows });
      commitTerminalScreen(screen);
    },
    [commitTerminalScreen, resolveVisibleRows],
  );

  const returnToBottom = useCallback(() => {
    const terminal = terminalRef.current;
    const model = screenModelRef.current;
    if (!terminal || !model) {
      return;
    }
    const screen = model.returnToBottom({ visibleRows: resolveVisibleRows(terminal) });
    commitTerminalScreen(screen);
  }, [commitTerminalScreen, resolveVisibleRows]);

  const resolveSelectionViewport = useCallback((): TerminalSelectionViewport | null => {
    const screen = terminalScreenRef.current;
    const metrics = metricsRef.current;
    const layout = layoutRef.current;
    if (!screen || !metrics) {
      return null;
    }

    const visibleCols = layout
      ? Math.min(screen.viewport.cols, Math.max(1, Math.floor(layout.width / metrics.cellWidth)))
      : screen.viewport.cols;
    return {
      firstRow: screen.viewport.firstRow,
      rows: screen.viewport.grid.length,
      cols: visibleCols,
    };
  }, []);

  const resolveSelectionCoordinate = useCallback(
    (point: { x: number; y: number }): TerminalBufferCoordinate | null => {
      const metrics = metricsRef.current;
      const viewport = resolveSelectionViewport();
      if (!metrics || !viewport) {
        return null;
      }
      return hitTestTerminalSelectionCell({ point, metrics, viewport });
    },
    [resolveSelectionViewport],
  );

  const beginSelectionAtPoint = useCallback(
    (point: { x: number; y: number }) => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      const coordinate = resolveSelectionCoordinate(point);
      if (!coordinate) {
        return;
      }
      const bounds = terminal.getBufferBounds();
      const wordSelection = resolveTerminalWordSelection({ terminal, coordinate });
      let snapshot = selectionModelRef.current.begin({
        coordinate: wordSelection?.start ?? coordinate,
        bounds,
      });
      if (wordSelection && wordSelection.end.col !== wordSelection.start.col) {
        snapshot = selectionModelRef.current.update({ coordinate: wordSelection.end, bounds });
      }
      commitSelectionRange(snapshot.range);
    },
    [commitSelectionRange, resolveSelectionCoordinate],
  );

  const selectionController = useMemo(
    () =>
      createTerminalSelectionController({
        getGeometry: () => {
          const viewport = resolveSelectionViewport();
          const metrics = metricsRef.current;
          return viewport && metrics
            ? { range: selectionRangeRef.current, viewport, metrics }
            : null;
        },
        onBeginHandle: (endpoint, cols) =>
          selectionModelRef.current.beginEndpointDrag(endpoint, cols),
        onMoveHandle: (coordinate) => {
          const terminal = terminalRef.current;
          if (!terminal) return;
          commitSelectionRange(
            selectionModelRef.current.update({ coordinate, bounds: terminal.getBufferBounds() })
              .range,
          );
        },
        onLongPress: beginSelectionAtPoint,
        onTap: focusTerminalFromTap,
        onScroll: applyScroll,
        schedule: (callback, delay) => setTimeout(callback, delay) as unknown as number,
        cancel: (timer) => clearTimeout(timer),
      }),
    [
      applyScroll,
      beginSelectionAtPoint,
      commitSelectionRange,
      focusTerminalFromTap,
      resolveSelectionViewport,
    ],
  );
  selectionControllerRef.current = selectionController;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (event) => {
          const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
          gestureStartRef.current = point;
          selectionController.press(point);
        },
        onPanResponderMove: (_event, gesture) =>
          selectionController.move({
            x: gestureStartRef.current.x + gesture.dx,
            y: gestureStartRef.current.y + gesture.dy,
          }),
        onPanResponderRelease: () => selectionController.release(),
        onPanResponderTerminate: () => selectionController.cancel(),
      }),
    [selectionController],
  );

  const backgroundColor = xtermTheme.background ?? "#0b0b0b";
  const rootStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.root, { backgroundColor }],
    [backgroundColor],
  );

  const terminalState = terminalScreen?.viewport ?? null;
  const visibleFind = useMemo(() => {
    if (!findState || !terminalState || findState.matches.length === 0) return null;
    const firstRow = terminalState.firstRow;
    const lastRow = firstRow + terminalState.grid.length - 1;
    return {
      matches: findState.matches.filter(
        (match) => match.endRow >= firstRow && match.startRow <= lastRow,
      ),
      current: findState.matches[findState.current] ?? null,
    };
  }, [findState, terminalState]);
  const isScrolled = terminalScreen?.scroll.mode === "scrolled";
  const viewport = resolveSelectionViewport();
  const handles =
    viewport && cellMetrics
      ? terminalSelectionHandles({ range: selectionRange, viewport, metrics: cellMetrics })
      : [];
  const terminalGrid = terminalState ? (
    <TerminalGridView
      state={terminalState}
      xtermTheme={xtermTheme}
      fontFamily={fontFamily}
      fontSize={fontSize}
      style={styles.nativeGrid}
      selection={selectionRange}
      find={visibleFind}
      onCellMetricsChange={handleCellMetricsChange}
    />
  ) : null;

  return (
    <View onLayout={handleLayout} style={rootStyle} testID={testId}>
      <View {...panResponder.panHandlers} accessible={false} style={styles.nativeSurface}>
        {terminalGrid}
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {handles.map((handle) => (
            <View key={handle.endpoint}>
              <View
                style={[
                  styles.selectionStem,
                  {
                    left: Math.max(
                      0,
                      Math.min(handle.x - 1, viewport!.cols * cellMetrics!.cellWidth - 2),
                    ),
                    top: handle.stemTop,
                    height: handle.stemHeight,
                  },
                ]}
              />
              <Svg
                width={TERMINAL_SELECTION_GRIP_SIZE}
                height={TERMINAL_SELECTION_GRIP_SIZE}
                viewBox="0 0 18 18"
                style={[styles.selectionGrip, { left: handle.gripX - 9, top: handle.gripY - 9 }]}
              >
                <Path
                  fill="#2684ff"
                  d={
                    handle.gripDirection === "left"
                      ? "M18 0H9C4 0 0 4 0 9S4 18 9 18 18 14 18 9Z"
                      : "M0 0H9C14 0 18 4 18 9S14 18 9 18 0 14 0 9Z"
                  }
                  transform={handle.gripAbove ? "translate(0 18) scale(1 -1)" : undefined}
                />
              </Svg>
            </View>
          ))}
        </View>
        <TerminalInput
          ref={inputRef}
          isKeyboardVisible={isKeyboardVisible}
          onFocus={handleTerminalFocus}
          onInput={handleTerminalInput}
          onTerminalKey={handleNativeTerminalKey}
        />
      </View>
      {isScrolled ? (
        <Pressable
          accessibilityLabel="Bottom"
          accessibilityRole="button"
          onPress={returnToBottom}
          style={styles.followButton}
          testID="terminal-follow-bottom"
        >
          <Text style={styles.followButtonText}>Bottom</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function NativeGridTerminalEmulator(props: TerminalEmulatorProps) {
  return <NativeTerminalEmulator {...props} />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    position: "relative",
  },
  nativeSurface: {
    backgroundColor: "transparent",
    flex: 1,
  },
  nativeGrid: {
    flex: 1,
  },
  selectionGrip: { position: "absolute" },
  selectionStem: { position: "absolute", width: 2, backgroundColor: "#2684ff" },
  followButton: {
    position: "absolute",
    right: 12,
    bottom: 12,
    zIndex: 2,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(32, 32, 32, 0.86)",
  },
  followButtonText: {
    color: "#f5f5f5",
    fontSize: 12,
    fontWeight: "600",
  },
});
