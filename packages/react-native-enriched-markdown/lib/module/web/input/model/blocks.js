"use strict";

// Line-scoped block types. Every line is a paragraph until a block handler
// claims it.

export const HEADING_BLOCK_TYPES = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
export const LIST_ITEM_BLOCK_TYPES = new Set(['unordered-list-item', 'ordered-list-item']);

// Block types whose emptied line persists as a zero-length anchor (an emptied
// heading stays a heading, an emptied list item keeps its marker).
export const ANCHORED_BLOCK_TYPES = new Set([...HEADING_BLOCK_TYPES, ...LIST_ITEM_BLOCK_TYPES]);
export function isListItem(block) {
  return block !== null && LIST_ITEM_BLOCK_TYPES.has(block.type);
}
const HEADING_BLOCK_TYPES_SET = new Set(HEADING_BLOCK_TYPES);
export function isHeading(block) {
  return block !== null && HEADING_BLOCK_TYPES_SET.has(block.type);
}
export function blockTypeForHeadingLevel(level) {
  return HEADING_BLOCK_TYPES[level - 1] ?? null;
}

// Maximum list nesting depth (0-based).
export const MAX_LIST_DEPTH = 5;

// A list line at depth d is indented (d + 1) * LIST_INDENT_PER_DEPTH px and
// its marker draws in the last slot (mirrors kENRMListIndentPerDepth).
export const LIST_INDENT_PER_DEPTH = 18;

// `level` is a generic payload: headings keep the H-level (1-6), list items
// their nesting depth. `ordinal` is the 1-based position of an ordered list
// item among adjacent siblings at the same depth, recomputed by the store.

export function createBlockRange(type, start, end, level = 0) {
  return {
    type,
    start,
    end,
    level,
    ordinal: 1
  };
}
//# sourceMappingURL=blocks.js.map
