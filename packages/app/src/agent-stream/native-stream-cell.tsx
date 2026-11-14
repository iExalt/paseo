import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import type { NativeRowLayout } from "./reading-anchor";

export interface NativeRowGeometrySink {
  rowLayout(rowId: string, layout: NativeRowLayout): void;
  forgetRow(rowId: string): void;
}

export const NativeRowGeometryContext = createContext<NativeRowGeometrySink | null>(null);

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
export function NativeStreamCell({
  cellKey,
  children,
  onFocusCapture,
  onLayout,
  style,
}: NativeStreamCellProps) {
  const sink = useContext(NativeRowGeometryContext);
  useEffect(() => () => sink?.forgetRow(cellKey), [cellKey, sink]);
  // Record before FlatList's handler: its viewability pass runs inside it and reads the frame.
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      sink?.rowLayout(cellKey, { y, height });
      onLayout?.(event);
    },
    [cellKey, sink, onLayout],
  );
  // RN's View typings omit the capture-phase focus prop FlatList's own cell sets.
  const focusProps = { onFocusCapture };
  return (
    <View style={style} onLayout={handleLayout} {...focusProps}>
      {children}
    </View>
  );
}
