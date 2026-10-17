import { createContext, useCallback, useContext, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/**
 * Width the composer toolbar's left controls have to spare. It reaches 0 once the right side
 * crowds them and they shrink to fit. Null until measured, and outside a composer toolbar.
 */
const ToolbarSpareWidthContext = createContext<number | null>(null);

export const ToolbarSpareWidthProvider = ToolbarSpareWidthContext.Provider;

export function useToolbarSpareWidth(): number | null {
  return useContext(ToolbarSpareWidthContext);
}

/**
 * Measures the left group against its contents. The group grows to fill the row, while the
 * contents keep their natural width until there is no room left, so the difference is the slack.
 */
export function useToolbarSpareWidthMeasure() {
  const [groupWidth, setGroupWidth] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const onGroupLayout = useCallback((event: LayoutChangeEvent) => {
    setGroupWidth(event.nativeEvent.layout.width);
  }, []);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentWidth(event.nativeEvent.layout.width);
  }, []);
  const spareWidth =
    groupWidth !== null && contentWidth !== null ? Math.max(0, groupWidth - contentWidth) : null;
  return { spareWidth, onGroupLayout, onContentLayout };
}
