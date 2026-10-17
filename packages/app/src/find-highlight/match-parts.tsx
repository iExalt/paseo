import type { ComponentType, ReactNode } from "react";
import type { StyleProp, Text, TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MatchPart } from "./split";

/** The selected occurrence's colors, the same as web chat find's highlight. */
export const findMatchStyles = StyleSheet.create((theme) => ({
  current: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));

interface SpanProps {
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}

/**
 * Text split at matches, with the selected occurrence wrapped in `Span`. Pass the span
 * the surrounding text composes with: a nested `Text`, or `MarkdownTextSpan` inside
 * Markdown so iOS keeps it in the paragraph's text view.
 */
export function renderMatchParts(
  parts: readonly MatchPart[],
  current: number,
  Span: ComponentType<SpanProps> | typeof Text,
): ReactNode[] {
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.text.length;
    if (part.match !== current) return part.text;
    return (
      <Span key={start} style={findMatchStyles.current}>
        {part.text}
      </Span>
    );
  });
}

/** Where a match starts in the text the parts split; the text's length when absent. */
export function matchPartsOffset(parts: readonly MatchPart[], match: number): number {
  let offset = 0;
  for (const part of parts) {
    if (part.match === match) return offset;
    offset += part.text.length;
  }
  return offset;
}
