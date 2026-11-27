"use strict";

import { createBlockRange, HEADING_BLOCK_TYPES, LIST_ITEM_BLOCK_TYPES } from "../model/blocks.js";
import { createFormattingRange, INPUT_STYLE_TYPES } from "../model/inlineStyles.js";

// What `undo`/`redo` return is freshly built, so the caller may hand it
// straight to the stores, which mutate their ranges in place.

// Typed arrays rather than objects: a third of the size. Packing is also what
// copies the ranges, so the stores' in-place mutations cannot reach a stored
// snapshot.

// - `typing`: an insert with no newline, at a caret.
// - `deleting`: a single Backspace or Delete.
// - `composition`: anything an IME commits; merged until the composition ends.
// - `other`: newlines, paste, cut, replacements, commands. Never merged.

// Typing that pauses longer than this starts a new undo step.
export const GROUP_INTERVAL_MS = 500;
export const MAX_HISTORY_DEPTH = 100;
const BLOCK_TYPES = ['paragraph', ...HEADING_BLOCK_TYPES, ...LIST_ITEM_BLOCK_TYPES];
function pack(snapshot) {
  const {
    formatting,
    blocks
  } = snapshot;
  const packedFormatting = new Int32Array(formatting.length * 3);
  let urls = null;
  formatting.forEach((range, i) => {
    packedFormatting[i * 3] = INPUT_STYLE_TYPES.indexOf(range.type);
    packedFormatting[i * 3 + 1] = range.start;
    packedFormatting[i * 3 + 2] = range.end;
    if (range.url !== undefined) {
      urls ??= new Map();
      urls.set(i, range.url);
    }
  });
  const packedBlocks = new Int32Array(blocks.length * 4);
  blocks.forEach((range, i) => {
    packedBlocks[i * 4] = BLOCK_TYPES.indexOf(range.type);
    packedBlocks[i * 4 + 1] = range.start;
    packedBlocks[i * 4 + 2] = range.end;
    packedBlocks[i * 4 + 3] = range.level;
  });
  return {
    formatting: packedFormatting,
    urls,
    blocks: packedBlocks,
    selection: {
      ...snapshot.selection
    },
    backward: snapshot.backward
  };
}
function unpack(packed) {
  const formatting = [];
  for (let i = 0; i < packed.formatting.length / 3; i++) {
    formatting.push(createFormattingRange(INPUT_STYLE_TYPES[packed.formatting[i * 3]], packed.formatting[i * 3 + 1], packed.formatting[i * 3 + 2], packed.urls?.get(i)));
  }
  const blocks = [];
  for (let i = 0; i < packed.blocks.length / 4; i++) {
    blocks.push(createBlockRange(BLOCK_TYPES[packed.blocks[i * 4]], packed.blocks[i * 4 + 1], packed.blocks[i * 4 + 2], packed.blocks[i * 4 + 3]));
  }
  return {
    formatting,
    blocks,
    selection: {
      ...packed.selection
    },
    backward: packed.backward
  };
}

// Text is kept as the edits themselves and replayed backwards; ranges and
// selection as one snapshot per entry, taken when the entry opens. Pure: the
// host captures and restores.
//
// Snapshots are whole, not scoped to the edit: an edit reaches ranges well
// outside its own span (deleting a list item re-clamps the depth of every
// item nested below it, and ordinals renumber down the list).
export class EditHistory {
  undoStack = [];
  redoStack = [];
  // Whether the newest undo entry may still take more edits.
  open = false;
  // What `recordFormatting` cleared, held until something else is recorded,
  // so a command that turns out to change nothing can be taken back whole.
  discardable = null;
  constructor(now = () => performance.now(), maxDepth = MAX_HISTORY_DEPTH) {
    this.now = now;
    this.maxDepth = maxDepth;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get state() {
    return {
      canUndo: this.canUndo,
      canRedo: this.canRedo
    };
  }

  // `captureBefore` runs only when the edit opens a new entry: once per undo
  // step, not once per keystroke. `caret` is where the edit leaves it.
  record(edit, kind, captureBefore, caret = edit.editStart + edit.insertedText.length) {
    const at = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    this.discardable = null;
    this.redoStack = [];
    if (top !== undefined && this.open && merges(top, edit, kind, at)) {
      top.edits.push({
        ...edit
      });
      top.lastAt = at;
      top.caret = caret;
      return;
    }
    this.push({
      edits: [{
        ...edit
      }],
      before: pack(captureBefore()),
      after: null,
      kind,
      lastAt: at,
      caret
    });
    this.open = kind !== 'other';
  }

  // A change to the ranges alone. Always an entry of its own.
  recordFormatting(captureBefore) {
    const entry = {
      edits: [],
      before: pack(captureBefore()),
      after: null,
      kind: 'other',
      lastAt: this.now(),
      caret: 0
    };
    this.discardable = {
      entry,
      redo: this.redoStack
    };
    this.redoStack = [];
    this.push(entry);
    this.open = false;
  }

  // Takes back the entry `recordFormatting` just opened, for a command that
  // ended up changing nothing, and puts back the redo steps it cleared.
  discardFormatting() {
    const discardable = this.discardable;
    this.discardable = null;
    if (discardable === null || this.undoStack[this.undoStack.length - 1] !== discardable.entry) {
      return;
    }
    this.undoStack.pop();
    this.redoStack = discardable.redo;
  }

  // The next edit starts a new entry, whatever it is.
  breakGroup() {
    this.open = false;
  }
  undo(captureAfter) {
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      return null;
    }
    this.open = false;
    this.discardable = null;
    entry.after = {
      ...pack(captureAfter()),
      ...selectionAfter(entry)
    };
    this.redoStack.push(entry);
    return {
      edits: entry.edits,
      target: unpack(entry.before)
    };
  }
  redo() {
    const entry = this.redoStack.pop();
    if (entry === undefined || entry.after === null) {
      return null;
    }
    this.open = false;
    this.discardable = null;
    this.undoStack.push(entry);
    return {
      edits: entry.edits,
      target: unpack(entry.after)
    };
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.open = false;
    this.discardable = null;
  }
  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
  }
}
function selectionAfter(entry) {
  if (entry.edits.length === 0) {
    return {
      selection: {
        ...entry.before.selection
      },
      backward: entry.before.backward
    };
  }
  return {
    selection: {
      start: entry.caret,
      end: entry.caret
    },
    backward: false
  };
}
function merges(top, edit, kind, at) {
  if (top.kind !== kind) {
    return false;
  }
  // An IME's updates rewrite their own word in place, wherever it began, and
  // land as one step however long the user takes to pick a candidate.
  if (kind === 'composition') {
    return true;
  }
  if (at - top.lastAt > GROUP_INTERVAL_MS) {
    return false;
  }
  const last = top.edits[top.edits.length - 1];
  if (kind === 'typing') {
    return edit.editStart === top.caret;
  }
  if (kind === 'deleting') {
    // Backspace ends where the previous delete began; Delete starts there.
    return edit.editStart + edit.deletedText.length === last.editStart || edit.editStart === last.editStart;
  }
  return false;
}
//# sourceMappingURL=EditHistory.js.map
