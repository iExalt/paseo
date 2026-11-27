"use strict";

import { ANCHORED_BLOCK_TYPES, createBlockRange, LIST_ITEM_BLOCK_TYPES, MAX_LIST_DEPTH } from "../model/blocks.js";
import { adjustRangesForEdit } from "./RangeEditAdjustment.js";
import { sortedInsertionIndex } from "./rangeStoreUtils.js";
import { clamp, firstIndexReachingTarget } from "../utils.js";
const NEWLINE = 10;

// Expands a selection to cover whole lines (line-scoped block boundaries).
export function paragraphBounds(rangeStart, rangeEnd, text) {
  if (text.length === 0) {
    return {
      start: 0,
      end: 0
    };
  }
  const clampedStart = clamp(rangeStart, 0, text.length);
  const clampedEnd = clamp(rangeEnd, clampedStart, text.length);
  const nextNewline = text.indexOf('\n', clampedEnd);
  return {
    start: lineStartBefore(clampedStart, text),
    end: nextNewline === -1 ? text.length : nextNewline
  };
}

// `position` must already be in [0, text.length]. Guarded at 0 because
// `lastIndexOf` clamps a negative `fromIndex` to 0 and would match a leading
// newline.
function lineStartBefore(position, text) {
  return position === 0 ? 0 : text.lastIndexOf('\n', position - 1) + 1;
}
function isLineStart(position, text) {
  return position === 0 || text.charCodeAt(position - 1) === NEWLINE;
}
export function lineAtPosition(position, text) {
  return paragraphBounds(position, position, text);
}

// Bounds of every line the selection touches, first to last. A selection
// ending right after a line break - Chrome's triple-click, a drag to the
// start of the next line - selects nothing of the line after it, so that
// line is left out (Slate's `unhangRange`; iOS stops at the last selected
// character's paragraph too).
export function linesTouching(selection, text) {
  const lines = [];
  const selectionEnd = selection.end > selection.start && text.charCodeAt(selection.end - 1) === NEWLINE ? selection.end - 1 : selection.end;
  const {
    end
  } = paragraphBounds(selection.start, selectionEnd, text);
  let line = lineAtPosition(selection.start, text);
  while (true) {
    lines.push(line);
    if (line.end >= end) {
      return lines;
    }
    line = lineAtPosition(line.end + 1, text);
  }
}

// What `rewriteLines` puts on a line: a block (the existing one, returned as
// is, stays untouched), or `null` for a plain paragraph.

// The writes available inside `BlockStore.edit`, all against the text that
// call was given.

// Block ranges never overlap: at most one block covers any paragraph, and
// ranges stay normalized to whole-line boundaries.
//
// Every write goes through `edit`, which normalizes and recomputes list
// metadata once all of them are in. The natives leave that normalize to each
// caller; here it cannot be forgotten.
export class BlockStore {
  ranges = [];

  // A live view, as on Android: read it right away and don't keep it across a
  // write - some writes change the array in place, others swap it.
  get allRanges() {
    return this.ranges;
  }
  get isEmpty() {
    return this.ranges.length === 0;
  }

  // Incoming ranges are trusted to be one per line and line-scoped: imports
  // arrive normalized (`normalizeBlockRanges`), history restores what the
  // store itself held.
  setRanges(newRanges) {
    this.ranges = [...newRanges].sort((a, b) => a.start - b.start);
    this.recomputeListMetadata();
  }
  clearAll() {
    this.ranges = [];
  }

  // Runs `writes` against `text` (the final buffer), then normalizes to line
  // bounds and recomputes list metadata once. That pass runs only here and in
  // `setRanges`: the ancestry clamp mutates `level` in place, so a pass over a
  // half-written chain is destructive - it sees the gap where a line has not
  // been written yet, or a merged block not yet stretched over its line,
  // flattens the item after it, and the finished chain can no longer tell
  // what that depth was. Reads (`blockAt`, `blockStartingAt`) are fine
  // mid-edit, but list metadata is stale until `edit` returns. If a write
  // throws, the normalize is skipped.
  edit(text, writes) {
    writes({
      setBlock: (type, level, paragraphStart, paragraphEnd) => this.setBlock(type, level, paragraphStart, paragraphEnd, text),
      removeBlock: (paragraphStart, paragraphEnd) => this.removeBlock(paragraphStart, paragraphEnd, text),
      rewriteLines: (lines, blockFor) => this.rewriteLines(lines, blockFor),
      adjustForEdit: (editLocation, deletedLength, insertedLength) => this.adjustForEdit(editLocation, deletedLength, insertedLength),
      pruneOrphanedAnchors: () => this.pruneOrphanedAnchors(text)
    });
    this.normalizeToLineBounds(text);
  }
  setBlock(type, level, paragraphStart, paragraphEnd, text) {
    const {
      start,
      end
    } = paragraphBounds(paragraphStart, paragraphEnd, text);
    const [from, to] = this.overlapWindow(start, end);
    // An anchored block (heading, list item) on an empty line is kept as a
    // zero-length anchor; other blocks need real content. `paragraphBounds`
    // never returns an inverted range, so `end === start` is the empty line.
    if (end > start || ANCHORED_BLOCK_TYPES.has(type)) {
      this.ranges.splice(from, to - from, createBlockRange(type, start, end, level));
    } else {
      this.ranges.splice(from, to - from);
    }
  }
  removeBlock(paragraphStart, paragraphEnd, text) {
    const {
      start,
      end
    } = paragraphBounds(paragraphStart, paragraphEnd, text);
    const [from, to] = this.overlapWindow(start, end);
    this.ranges.splice(from, to - from);
  }

  // `lines` must be consecutive, as `linesTouching` returns them. Anything
  // else the span overlaps goes, as with `setBlock` per line, which would copy
  // or shift the array once per line.
  rewriteLines(lines, blockFor) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const [from, to] = this.overlapWindow(first.start, last.end);
    const written = [];
    let cursor = from;
    for (const line of lines) {
      while (cursor < to && this.ranges[cursor].start < line.start) {
        cursor++;
      }
      const candidate = cursor < to ? this.ranges[cursor] : null;
      const existing = candidate?.start === line.start ? candidate : null;
      const block = blockFor(line, existing);
      if (block === null) {
        continue;
      }
      if (block === existing) {
        written.push(existing);
      } else if (line.end > line.start || ANCHORED_BLOCK_TYPES.has(block.type)) {
        written.push(createBlockRange(block.type, line.start, line.end, block.level));
      }
    }
    // Not `splice(from, n, ...written)`: spreading a select-all's worth of
    // blocks as arguments overflows the stack.
    this.ranges = this.ranges.slice(0, from).concat(written, this.ranges.slice(to));
  }

  // Drops anchored blocks (headings, list items) whose start is no longer at
  // a line start, as happens when Backspace merges their line into the one
  // above. Mirrors iOS's `pruneOrphanedBlockAnchors` and Android's
  // `pruneOrphanedAnchors`.
  //
  // Must run BEFORE `normalizeToLineBounds`, so a merged range is judged on
  // its unsnapped anchor: normalize would otherwise snap the orphan onto the
  // line it was merged into and spread it over that line's text, promoting a
  // plain paragraph into a heading or a bullet. Only the orphan goes - a
  // legitimate block on the merged-into line keeps its line.
  pruneOrphanedAnchors(text) {
    this.ranges = this.ranges.filter(range => {
      if (!ANCHORED_BLOCK_TYPES.has(range.type)) {
        return true;
      }
      return isLineStart(clamp(range.start, 0, text.length), text);
    });
  }

  // Snaps every stored range to the line bounds of its start position.
  // Absorbs edge-typed chars, clips split ranges to their first line, drops
  // duplicates. On an empty line an anchored block persists as a zero-length
  // anchor; any other collapsed range is dropped. Call after adjustForEdit
  // once `text` is final. Idempotent.
  normalizeToLineBounds(text) {
    if (this.ranges.length === 0) {
      return;
    }
    let previousEnd = -1;
    this.ranges = this.ranges.filter(range => {
      const line = lineAtPosition(range.start, text);
      const isEmptyLine = line.end === line.start;
      if (isEmptyLine && !ANCHORED_BLOCK_TYPES.has(range.type) || line.start <= previousEnd) {
        // Deliberately silent: a heading anchor and the block it merges into
        // can briefly share a start after a line-join.
        return false;
      }
      range.start = line.start;
      range.end = line.end;
      previousEnd = line.end;
      return true;
    });
    this.recomputeListMetadata();
  }

  // Clamps list depths to valid ancestry (an item nests at most one level
  // under the previous adjacent list item — CommonMark cannot represent
  // orphan nesting) and renumbers ordered items among their adjacent
  // same-depth, same-type run.
  recomputeListMetadata() {
    let prevEnd = -2;
    let prevDepth = -1;
    const counters = new Array(MAX_LIST_DEPTH + 1).fill(0);
    const counterTypes = new Array(MAX_LIST_DEPTH + 1).fill(null);
    for (const range of this.ranges) {
      if (!LIST_ITEM_BLOCK_TYPES.has(range.type)) {
        prevDepth = -1;
        continue;
      }
      const adjacent = prevDepth >= 0 && range.start === prevEnd + 1;
      if (!adjacent) {
        counters.fill(0);
        counterTypes.fill(null);
      }
      // Coerce into [0, MAX_LIST_DEPTH] before ancestry-clamping: this pass
      // indexes the counter arrays by depth, so an out-of-bounds level must
      // never survive it.
      const maxDepth = Math.min(adjacent ? prevDepth + 1 : 0, MAX_LIST_DEPTH);
      if (range.level > maxDepth) {
        range.level = maxDepth;
      } else if (range.level < 0) {
        range.level = 0;
      }
      const depth = range.level;
      for (let i = depth + 1; i <= MAX_LIST_DEPTH; i++) {
        counters[i] = 0;
        counterTypes[i] = null;
      }
      if (counterTypes[depth] !== range.type) {
        counters[depth] = 0;
        counterTypes[depth] = range.type;
      }
      counters[depth] = counters[depth] + 1;
      range.ordinal = counters[depth];
      prevEnd = range.end;
      prevDepth = range.level;
    }
  }

  // The index window [from, to) of the blocks overlapping [start, end]: a
  // block touching the bounds goes wholesale, and a zero-length anchor goes
  // when it sits within them (so toggle-off clears an empty line). Blocks are
  // sorted by start and never overlap, so the touched ones sit side by side,
  // and only the one right before the first start at or past `start` can
  // reach into the bounds from the left. Ends are not assumed line-snapped:
  // mid-edit a block can still span the newline that just split its line.
  overlapWindow(start, end) {
    let from = sortedInsertionIndex(this.ranges, start - 1);
    if (from > 0 && this.ranges[from - 1].end > start) {
      from--;
    }
    let to = from;
    while (to < this.ranges.length) {
      const block = this.ranges[to];
      const overlaps = block.end === block.start ? block.start <= end : block.start < end;
      if (!overlaps) {
        break;
      }
      to++;
    }
    return [from, to];
  }

  // Shifts/clips block ranges to follow a text edit, with anchored-block
  // persistence layered on top: a block deleted exactly to its end collapses
  // to a zero-length anchor at the edit location (its line survives), and
  // existing anchors shift/keep/drop with their line.
  //
  // Text inserted at a block's start shifts the range off the line start
  // rather than growing it, and normalizeToLineBounds snaps it back over the
  // typed characters. Growing here instead would look equivalent for a plain
  // character but breaks Enter at a line start: the block would stretch over
  // the new empty line, normalize to it, and strand the block as an empty
  // anchor while its own text on the next line lost the block.
  adjustForEdit(editLocation, deletedLength, insertedLength) {
    if (deletedLength === 0 && insertedLength === 0) {
      return;
    }
    const deleteEnd = editLocation + deletedLength;
    const delta = insertedLength - deletedLength;
    const anchors = this.ranges.filter(b => b.end === b.start && ANCHORED_BLOCK_TYPES.has(b.type));
    let ranges = this.ranges.filter(b => b.end !== b.start);

    // At most one range can end exactly at deleteEnd (blocks never overlap),
    // so this restores at most one collapsed block.
    const collapsed = ranges.find(b => ANCHORED_BLOCK_TYPES.has(b.type) && b.start >= editLocation && b.end === deleteEnd) ?? null;
    ranges = adjustRangesForEdit(ranges, editLocation, deletedLength, insertedLength, () => true);
    for (const anchor of anchors) {
      if (anchor.start <= editLocation) {
        // Keeps its position.
      } else if (anchor.start >= deleteEnd) {
        anchor.start += delta;
        anchor.end = anchor.start;
      } else {
        continue; // The anchor's line was deleted.
      }
      ranges.splice(sortedInsertionIndex(ranges, anchor.start), 0, anchor);
    }
    if (collapsed !== null && !ranges.includes(collapsed)) {
      const anchor = createBlockRange(collapsed.type, editLocation, editLocation, collapsed.level);
      ranges.splice(sortedInsertionIndex(ranges, editLocation), 0, anchor);
    }
    this.ranges = ranges;
  }
  blockAt(position, text) {
    return this.blockStartingAt(lineStartBefore(clamp(position, 0, text.length), text));
  }

  // Starts are unique (one block per paragraph), so the first range reaching
  // `lineStart` is the block starting there, when one does.
  blockStartingAt(lineStart) {
    const index = firstIndexReachingTarget(lineStart, this.ranges.length, position => this.ranges[position].start);
    const block = this.ranges[index];
    return block !== undefined && block.start === lineStart ? block : null;
  }
}
//# sourceMappingURL=BlockStore.js.map
