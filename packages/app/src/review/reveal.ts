import { createContext } from "react";
import type { View } from "react-native";

/** A scrolling host that keeps the focused review editor clear of the soft keyboard. */
export interface ReviewEditorRevealHost {
  focusEditor: (element: View) => void;
  releaseEditor: (element: View) => void;
}

export const ReviewEditorRevealContext = createContext<ReviewEditorRevealHost | null>(null);

/**
 * The scroll offset that brings an element into the visible band, or null when it is already
 * inside. An element taller than the band, or above it, aligns its top with the band's top.
 */
export function resolveRevealScrollTop(input: {
  elementTop: number;
  elementBottom: number;
  visibleTop: number;
  visibleBottom: number;
  scrollTop: number;
}): number | null {
  const tooTall = input.elementBottom - input.elementTop > input.visibleBottom - input.visibleTop;
  if (tooTall || input.elementTop < input.visibleTop) {
    const delta = input.elementTop - input.visibleTop;
    return delta === 0 ? null : input.scrollTop + delta;
  }
  if (input.elementBottom <= input.visibleBottom) return null;
  return input.scrollTop + input.elementBottom - input.visibleBottom;
}
