import type { RangeBounds } from './rangeBounds';
export type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'unordered-list-item' | 'ordered-list-item';
export declare const HEADING_BLOCK_TYPES: readonly ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
export declare const LIST_ITEM_BLOCK_TYPES: ReadonlySet<BlockType>;
export declare const ANCHORED_BLOCK_TYPES: ReadonlySet<BlockType>;
export declare function isListItem(block: BlockRange | null): block is BlockRange;
export declare function isHeading(block: BlockRange | null): block is BlockRange;
export declare function blockTypeForHeadingLevel(level: number): BlockType | null;
export declare const MAX_LIST_DEPTH = 5;
export declare const LIST_INDENT_PER_DEPTH = 18;
export interface BlockRange extends RangeBounds {
    type: BlockType;
    level: number;
    ordinal: number;
}
export declare function createBlockRange(type: BlockType, start: number, end: number, level?: number): BlockRange;
//# sourceMappingURL=blocks.d.ts.map