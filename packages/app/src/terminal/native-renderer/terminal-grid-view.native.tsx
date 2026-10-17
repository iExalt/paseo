import { useCallback, useMemo, useRef, useState } from "react";
import {
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ITheme } from "@xterm/xterm";

import {
  PaseoTerminalView,
  type PaseoTerminalCellMetrics,
  type PaseoTerminalTheme,
} from "../../../modules/paseo-terminal";
import {
  createTerminalCellStyleResolver,
  parseTerminalColor,
  DEFAULT_TERMINAL_THEME,
  NATIVE_TERMINAL_SELECTION_COLORS,
} from "./colors";
import { resolveNativeTerminalFontFamily } from "./font.native";
import type { TerminalViewportState } from "./headless-terminal-state";
import {
  resolveTerminalGridMetricsMeasurement,
  type TerminalGridCellMetrics,
} from "./terminal-grid-metrics";
import type { TerminalFindMatch } from "./terminal-buffer-search";
import { buildTerminalFrame } from "./terminal-frame";
import type { TerminalSelectionRange } from "./terminal-selection";

const DEFAULT_FONT_SIZE = 12;

export interface TerminalGridViewProps {
  state: TerminalViewportState;
  xtermTheme?: ITheme;
  fontFamily?: string;
  fontSize?: number;
  style?: StyleProp<ViewStyle>;
  selection?: TerminalSelectionRange | null;
  /** Find matches in absolute rows; only those on screen need passing. */
  find?: { matches: readonly TerminalFindMatch[]; current: TerminalFindMatch | null } | null;
  onCellMetricsChange?: (metrics: TerminalGridCellMetrics) => void;
}

function resolveVisibleCols(input: {
  viewportWidth: number | null;
  cellWidth: number | null;
  gridCols: number;
}): number {
  if (input.viewportWidth === null || input.cellWidth === null) {
    return input.gridCols;
  }
  if (input.viewportWidth <= 0 || input.cellWidth <= 0 || input.gridCols <= 0) {
    return 0;
  }
  return Math.min(input.gridCols, Math.max(1, Math.floor(input.viewportWidth / input.cellWidth)));
}

export function TerminalGridView({
  state,
  xtermTheme = DEFAULT_TERMINAL_THEME,
  fontFamily,
  fontSize = DEFAULT_FONT_SIZE,
  style,
  selection = null,
  find = null,
  onCellMetricsChange,
}: TerminalGridViewProps) {
  const { fontScale } = useWindowDimensions();
  const [cellWidth, setCellWidth] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const measuredMetricsRef = useRef<TerminalGridCellMetrics | null>(null);
  const resolvedFontFamily = useMemo(
    () => resolveNativeTerminalFontFamily(fontFamily),
    [fontFamily],
  );
  const resolver = useMemo(() => createTerminalCellStyleResolver(xtermTheme), [xtermTheme]);
  const theme = useMemo<PaseoTerminalTheme>(
    () => ({
      background: resolver.backgroundColor,
      cursor: resolver.cursorColor,
      selectionBackground: NATIVE_TERMINAL_SELECTION_COLORS.background,
    }),
    [resolver],
  );
  const columns = resolveVisibleCols({ viewportWidth, cellWidth, gridCols: state.cols });
  const frame = useMemo(() => {
    if (!find) return buildTerminalFrame({ state, columns, resolver, selection });
    const highlights = new Map<object, number>();
    const mark = (match: TerminalFindMatch, color: number) => {
      const first = Math.max(match.startRow, state.firstRow);
      const last = Math.min(match.endRow, state.firstRow + state.grid.length - 1);
      for (let row = first; row <= last; row += 1) {
        const cells = state.grid[row - state.firstRow]!;
        const start = row === match.startRow ? match.startCol : 0;
        const end = row === match.endRow ? match.endCol : columns;
        for (let col = 0; col < Math.min(columns, cells.length); col += 1) {
          const cell = cells[col]!;
          if (col < end && col + Math.max(1, cell.width ?? 1) > start) highlights.set(cell, color);
        }
      }
    };
    const matchColor = parseTerminalColor(xtermTheme.yellow, 0xffb58900);
    const currentColor = parseTerminalColor(xtermTheme.blue, 0xff268bd2);
    for (const match of find.matches) mark(match, matchColor);
    if (find.current) mark(find.current, currentColor);
    const findResolver = {
      ...resolver,
      resolve: (cell: Parameters<typeof resolver.resolve>[0]) => {
        const style = resolver.resolve(cell);
        const background = highlights.get(cell);
        return background === undefined ? style : {
          ...style, background, foreground: resolver.backgroundColor,
        };
      },
    };
    return buildTerminalFrame({ state, columns, resolver: findResolver, selection });
  }, [columns, find, resolver, selection, state, xtermTheme]);

  const handleCellMetrics = useCallback(
    (metrics: PaseoTerminalCellMetrics) => {
      const changedMetrics = resolveTerminalGridMetricsMeasurement(
        measuredMetricsRef.current,
        metrics,
      );
      if (!changedMetrics) {
        return;
      }
      measuredMetricsRef.current = changedMetrics;
      setCellWidth(changedMetrics.cellWidth);
      onCellMetricsChange?.(changedMetrics);
    },
    [onCellMetricsChange],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setViewportWidth((current) => (current === width ? current : width));
  }, []);

  return (
    <View onLayout={handleContainerLayout} pointerEvents="none" style={[styles.root, style]}>
      <PaseoTerminalView
        frame={frame}
        theme={theme}
        fontFamily={resolvedFontFamily}
        fontSize={fontSize * fontScale}
        onCellMetrics={handleCellMetrics}
        style={styles.surface}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: "hidden",
  },
  surface: {
    flex: 1,
  },
});
