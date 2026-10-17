import { useCallback, useEffect, useRef } from "react";
import type { NativeSyntheticEvent, Text, TextLayoutEventData, View } from "react-native";
import { lineAtOffset, type TextLine } from "@/find-highlight/reveal";
import { setChatFindAnchor } from "./highlight-store";

/** The selected occurrence: which item draws it and where in its root Text it starts. */
export interface ChatFindAnchorTarget {
  itemId: string;
  index: number;
  offset: number;
}

/**
 * Props for the root Text that draws the selected occurrence. They register a measure
 * of the occurrence's line, in window coordinates, for reveal to scroll to.
 */
export function useChatFindAnchorText(target: ChatFindAnchorTarget | null) {
  const textRef = useRef<Text>(null);
  const lines = useRef<readonly TextLine[]>([]);
  const onTextLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    lines.current = event.nativeEvent.lines;
  }, []);
  const itemId = target?.itemId ?? null;
  const index = target?.index ?? -1;
  const offset = target?.offset ?? 0;
  useEffect(() => {
    if (itemId === null) return undefined;
    return setChatFindAnchor({
      itemId,
      index,
      measure: () =>
        new Promise((resolve) => {
          const text = textRef.current;
          // A host that has not laid out its lines yet, such as one that just
          // remounted to carry the anchor, would measure as its whole height.
          const line = lineAtOffset(lines.current, offset);
          if (!text || !line) {
            resolve(null);
            return;
          }
          text.measureInWindow((_x, y) => resolve({ top: y + line.y, height: line.height }));
        }),
    });
  }, [index, itemId, offset]);
  return { textRef, onTextLayout };
}

// About one line of chat text; the occurrence's own line is not measurable here.
const ESTIMATED_LINE_HEIGHT = 24;

/**
 * A ref for a View that draws the selected occurrence where its lines cannot be read,
 * such as natively drawn Markdown. Reveal measures the View and places the occurrence
 * `fraction` of the way down it, which is exact for a one-line block and close for a
 * paragraph.
 */
export function useChatFindAnchorView(target: ChatFindAnchorTarget | null, fraction: number) {
  const viewRef = useRef<View>(null);
  const itemId = target?.itemId ?? null;
  const index = target?.index ?? -1;
  useEffect(() => {
    if (itemId === null) return undefined;
    return setChatFindAnchor({
      itemId,
      index,
      measure: () =>
        new Promise((resolve) => {
          const view = viewRef.current;
          if (!view) {
            resolve(null);
            return;
          }
          view.measureInWindow((_x, y, _width, height) => {
            // Not laid out yet: an unmeasured View reports no height.
            if (height <= 0) {
              resolve(null);
              return;
            }
            const lineHeight = Math.min(height, ESTIMATED_LINE_HEIGHT);
            const offset = Math.min(Math.max(height * fraction, 0), height - lineHeight);
            resolve({ top: y + offset, height: lineHeight });
          });
        }),
    });
  }, [fraction, index, itemId]);
  return viewRef;
}
