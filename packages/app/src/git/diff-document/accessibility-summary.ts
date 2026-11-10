import type { DiffCell, DiffDocumentModel, DiffRow } from "./types";

const MAX_CELLS = 200;
const MAX_CHARS = 12_000;
const MAX_LINE_CHARS = 500;

/** Summarize the visible canvas, without walking or exposing the whole document. */
export function diffAccessibilitySummary(
  model: Pick<DiffDocumentModel, "rows">,
  scrollTop: number,
  viewportHeight: number,
): string {
  if (viewportHeight <= 0) return "";
  const rows = model.rows;
  const start = firstVisibleRow(rows, scrollTop);
  const output: string[] = [];
  let length = 0;
  let cells = 0;
  let path = "";
  let omitted = false;
  const append = (text: string) => {
    if (length + text.length + 1 > MAX_CHARS - 20) {
      omitted = true;
      return false;
    }
    output.push(text);
    length += text.length + 1;
    return true;
  };
  for (let index = start; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.top >= scrollTop + viewportHeight) break;
    if (row.path !== path) {
      path = row.path;
      if (!append(path)) break;
    }
    if (row.kind === "status") {
      if (!append(row.label)) break;
      continue;
    }
    for (const [cellIndex, cell] of row.cells.entries()) {
      if (!cell || cell.type === "empty") continue;
      const previous = cellIndex > 0 ? row.cells[cellIndex - 1] : null;
      if (duplicateContext(previous, cell)) continue;
      if (cells++ >= MAX_CELLS) {
        omitted = true;
        break;
      }
      const line = describeCell(cell);
      if (!append(line)) break;
    }
    if (omitted) break;
  }
  if (omitted) output.push("More lines omitted");
  return output.join("\n");
}

function firstVisibleRow(rows: DiffRow[], scrollTop: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const row = rows[mid]!;
    if (row.top + row.height <= scrollTop) low = mid + 1;
    else high = mid;
  }
  return low;
}

function duplicateContext(previous: DiffCell | null | undefined, cell: DiffCell): boolean {
  return (
    !!previous &&
    cell.type === "context" &&
    previous.type === "context" &&
    previous.content === cell.content
  );
}

function describeCell(cell: DiffCell): string {
  let marker = "Context";
  if (cell.type === "add") marker = "Added";
  if (cell.type === "remove") marker = "Removed";
  const line =
    cell.content.length > MAX_LINE_CHARS
      ? `${cell.content.slice(0, MAX_LINE_CHARS)}…`
      : cell.content;
  return `${marker} ${cell.lineNumber ?? ""} ${line}`;
}
