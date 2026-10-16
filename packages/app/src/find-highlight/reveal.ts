/** A laid-out line of a Text, as `onTextLayout` reports it. */
export interface TextLine {
  text: string;
  y: number;
  height: number;
}

/**
 * The line holding a character offset. Line texts add up to the Text's string, so the
 * last line starting at or before the offset holds it.
 */
export function lineAtOffset(
  lines: readonly TextLine[],
  offset: number,
): { y: number; height: number } | null {
  let start = 0;
  let found: TextLine | null = null;
  for (const line of lines) {
    if (start > offset) break;
    found = line;
    start += line.text.length;
  }
  return found ? { y: found.y, height: found.height } : null;
}

/**
 * How far, in window pixels, content must move up so a match sits inside the visible
 * band; negative moves it down, 0 leaves a visible match alone. A match outside the
 * band lands in its middle, clear of controls floating at its edges, such as the
 * jump-to-bottom button above the find bar. A match taller than the band aligns its top.
 */
export function findRevealDelta(input: {
  visibleTop: number;
  visibleBottom: number;
  matchTop: number;
  matchHeight: number;
  margin: number;
}): number {
  const top = input.visibleTop + input.margin;
  const bottom = input.visibleBottom - input.margin;
  const matchBottom = input.matchTop + input.matchHeight;
  if (input.matchTop >= top && matchBottom <= bottom) return 0;
  if (input.matchHeight > bottom - top) return input.matchTop - top;
  return input.matchTop + input.matchHeight / 2 - (top + bottom) / 2;
}

/** The scroll offset that moves content up by `delta`; an inverted list scrolls the other way. */
export function scrollOffsetForDelta(offset: number, delta: number, inverted: boolean): number {
  return Math.max(0, inverted ? offset - delta : offset + delta);
}
