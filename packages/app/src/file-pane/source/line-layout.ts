/** Columns a tab advances to, the way the source view's monospace text lays it out. */
const TAB_COLUMNS = 8;

/** The measured size of one monospace character in the source view. */
export interface SourceCellSize {
  charWidth: number;
  lineHeight: number;
}

function expandTabs(text: string): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const char of text) {
    out += char === "\t" ? " ".repeat(TAB_COLUMNS - (out.length % TAB_COLUMNS)) : char;
  }
  return out;
}

/**
 * Rows a source line wraps to at `columns` characters per row. Lines wrap greedily at
 * spaces, as Android's simple break strategy does, and a word longer than a row breaks
 * inside it. Characters wider than one cell, such as CJK and emoji, count as one, so
 * lines full of them come out short.
 */
export function sourceLineRows(text: string, columns: number): number {
  const width = Math.max(1, columns);
  let rows = 1;
  let column = 0;
  for (const [, word, spaces] of expandTabs(text).matchAll(/(\S*)(\s*)/g)) {
    if (!word && !spaces) break;
    let length = word!.length;
    if (column > 0 && column + length > width) {
      rows += 1;
      column = 0;
    }
    while (length > width) {
      rows += 1;
      length -= width;
    }
    // Trailing spaces hang past the edge instead of opening a row.
    column += length + spaces!.length;
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
