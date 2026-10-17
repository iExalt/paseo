import type { IBuffer, IBufferCell, IBufferLine } from "@xterm/headless";

/** Matches counted before the status shows "+", the same cap web terminal find uses. */
export const TERMINAL_FIND_LIMIT = 20_000;

/** A match in absolute buffer rows, the coordinates selection uses; `endCol` is exclusive. */
export interface TerminalFindMatch {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function findPattern(query: string): RegExp | null {
  if (!query) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

interface LogicalLine {
  text: string;
  /** For each UTF-16 offset of `text`, its row index into the buffer and column. */
  rows: Int32Array;
  cols: Int32Array;
}

function lineText(buffer: IBuffer, first: number, last: number): string {
  let text = "";
  for (let index = first; index <= last; index += 1) {
    text += buffer.getLine(index)?.translateToString(index === last) ?? "";
  }
  return text;
}

/**
 * One logical line: a row and the soft-wrapped rows after it, as the reader sees one line.
 * Trailing blanks of the last row are dropped, like web find, so padding never matches.
 * Built only for lines that match, since walking cells costs far more than reading text.
 */
function readLogicalLine(
  buffer: IBuffer,
  first: number,
  last: number,
  cell: IBufferCell,
): LogicalLine {
  let text = "";
  const rows: number[] = [];
  const cols: number[] = [];
  for (let index = first; index <= last; index += 1) {
    const line = buffer.getLine(index) as IBufferLine;
    const end = index === last ? line.translateToString(true).length : Number.POSITIVE_INFINITY;
    let length = 0;
    for (let col = 0; col < line.length && length < end; col += 1) {
      line.getCell(col, cell);
      // The second cell of a wide character carries no text of its own.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let unit = 0; unit < chars.length; unit += 1) {
        rows.push(index);
        cols.push(col);
      }
      text += chars;
      length += chars.length;
    }
  }
  return { text, rows: Int32Array.from(rows), cols: Int32Array.from(cols) };
}

/**
 * Every match of the query in the buffer, oldest first, up to `limit`: literal and
 * case-insensitive like web terminal find, joined across soft wraps. `oldestRow` turns
 * buffer indexes into the absolute rows the native screen uses.
 */
export function searchTerminalBuffer(
  buffer: IBuffer,
  query: string,
  options: { oldestRow: number; cell: IBufferCell; limit?: number },
): { matches: TerminalFindMatch[]; limited: boolean } {
  const pattern = findPattern(query);
  const matches: TerminalFindMatch[] = [];
  if (!pattern) return { matches, limited: false };
  const limit = options.limit ?? TERMINAL_FIND_LIMIT;
  let first = 0;
  while (first < buffer.length) {
    let last = first;
    while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last += 1;
    pattern.lastIndex = 0;
    const matched = pattern.test(lineText(buffer, first, last));
    // `test` advances a global pattern; matchAll below starts from where it stops.
    pattern.lastIndex = 0;
    if (!matched) {
      first = last + 1;
      continue;
    }
    const line = readLogicalLine(buffer, first, last, options.cell);
    for (const found of line.text.matchAll(pattern)) {
      if (found[0].length === 0) continue;
      if (matches.length === limit) return { matches, limited: true };
      const end = found.index + found[0].length - 1;
      // A wide final character spans two cells, so the end column steps past both.
      const endWidth = buffer.getLine(line.rows[end]!)?.getCell(line.cols[end]!)?.getWidth() ?? 1;
      matches.push({
        startRow: options.oldestRow + line.rows[found.index]!,
        startCol: line.cols[found.index]!,
        endRow: options.oldestRow + line.rows[end]!,
        endCol: line.cols[end]! + Math.max(1, endWidth),
      });
    }
    first = last + 1;
  }
  return { matches, limited: false };
}
