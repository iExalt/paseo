/**
 * Tabs are expanded to spaces before the source view draws them: Android advances a tab
 * by a fixed pixel step, not by columns, so the drawn width and this model would drift.
 * Four columns matches CodeMirror's default on web.
 */
const TAB_COLUMNS = 4;

/** The measured size of one monospace character in the source view. */
export interface SourceCellSize {
  charWidth: number;
  lineHeight: number;
}

/** The text with tabs expanded, starting at `column` of its line. */
export function expandTabs(text: string, column = 0): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const char of text) {
    out += char === "\t" ? " ".repeat(TAB_COLUMNS - ((column + out.length) % TAB_COLUMNS)) : char;
  }
  return out;
}

/** Expands tabs across a line's styled runs, carrying the column from run to run. */
export function expandRunTabs<Run extends { text: string }>(runs: readonly Run[]): Run[] {
  let column = 0;
  return runs.map((run) => {
    const text = expandTabs(run.text, column);
    column += text.length;
    return text === run.text ? run : { ...run, text };
  });
}

/**
 * Rows a tab-expanded source line wraps to at `columns` characters per row. Lines wrap
 * greedily, as the view's `textBreakStrategy="simple"` does: after spaces and after
 * hyphens, and inside a word longer than a row. Other punctuation breaks and characters
 * wider than one cell, such as CJK and emoji, are not modelled, so lines full of them
 * come out off by a row.
 */
export function sourceLineRows(text: string, columns: number): number {
  const width = Math.max(1, columns);
  let rows = 1;
  let column = 0;
  for (const [piece] of text.matchAll(/\s+|[^\s-]*-+|[^\s-]+/g)) {
    if (/^\s/.test(piece)) {
      // Spaces hang past the edge instead of opening a row.
      column += piece.length;
      continue;
    }
    let length = piece.length;
    if (column > 0 && column + length > width) {
      rows += 1;
      column = 0;
    }
    while (length > width) {
      rows += 1;
      length -= width;
    }
    column += length;
  }
  return rows;
}

/** Each line's top offset, plus the total height as the last entry. */
export function sourceLineOffsets(
  lines: readonly string[],
  textWidth: number,
  cell: SourceCellSize,
): Float64Array {
  const columns = Math.floor(textWidth / cell.charWidth);
  const offsets = new Float64Array(lines.length + 1);
  for (let index = 0; index < lines.length; index += 1) {
    offsets[index + 1] = offsets[index]! + sourceLineRows(lines[index]!, columns) * cell.lineHeight;
  }
  return offsets;
}
