"use strict";

import { HEADING_BLOCK_TYPES, LIST_ITEM_BLOCK_TYPES } from "../model/blocks.js";
import { firstIndexReachingTarget, lineEndOf, lineStartsOf } from "../utils.js";

// The parser reports what md4c saw, which the stores' invariants do not
// always admit: nested same-type spans ("**foo **bar** baz**"), a setext
// heading over two lines, a heading inside a list item ("- # foo"). Edits
// assume those invariants, so an import that breaks them goes wrong on the
// first keystroke rather than at load.

// Sorted by start, with same-type ranges that overlap or touch merged into
// one, as edit paths keep them. Links merge only when their urls match:
// adjacent `[a](x)[b](y)` stays two links.
export function normalizeFormattingRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  // The last merged range of each type (and url, for links).
  const open = new Map();
  for (const range of sorted) {
    if (range.end <= range.start) {
      continue;
    }
    const key = range.type === 'link' ? `link\u0000${range.url ?? ''}` : range.type;
    const last = open.get(key);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    const copy = {
      ...range
    };
    merged.push(copy);
    open.set(key, copy);
  }
  return merged;
}

// When two blocks claim one line, the one kept. A list item is the outer
// structure ("- # foo" is an item holding a heading), and losing it would
// break the list's numbering and nesting around it; the line's text stays
// either way.
function blockPriority(type) {
  if (LIST_ITEM_BLOCK_TYPES.has(type)) {
    return 2;
  }
  return HEADING_BLOCK_TYPES.includes(type) ? 1 : 0;
}

// One block per line, covering exactly that line, sorted by start: what the
// block store holds after every edit. A block spanning lines is copied onto
// each of them, which is how the editor shows it (a two-line setext heading
// renders as two heading lines) and how it will serialize.
export function normalizeBlockRanges(text, blocks) {
  if (blocks.length === 0) {
    return [];
  }
  const lineStarts = lineStartsOf(text);
  const lineEnd = lineEndOf(text, lineStarts);

  // Indexed by line. Blocks arrive nearly sorted (a nested item is emitted
  // before its parent), so the line of each start is found walking from the
  // previous one, with a binary search only to go back.
  const byLine = [];
  let cursor = 0;
  const lineAt = position => {
    if (position < lineStarts[cursor]) {
      cursor = firstIndexReachingTarget(position, lineStarts.length, lineEnd);
    }
    while (cursor + 1 < lineStarts.length && lineEnd(cursor) < position) {
      cursor++;
    }
    return cursor;
  };
  for (const block of blocks) {
    const first = lineAt(block.start);
    let last = first;
    while (last + 1 < lineStarts.length && lineEnd(last) < block.end - 1) {
      last++;
    }
    for (let line = first; line <= last; line++) {
      const kept = byLine[line];
      if (kept !== undefined && blockPriority(kept.type) >= blockPriority(block.type)) {
        continue;
      }
      byLine[line] = {
        ...block,
        start: lineStarts[line],
        end: lineEnd(line)
      };
    }
  }
  return byLine.filter(block => block !== undefined);
}
//# sourceMappingURL=normalizeImport.js.map
