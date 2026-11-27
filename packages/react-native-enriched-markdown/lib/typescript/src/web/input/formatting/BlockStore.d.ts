import { type BlockRange, type BlockType } from '../model/blocks';
import type { RangeBounds } from '../model/rangeBounds';
export declare function paragraphBounds(rangeStart: number, rangeEnd: number, text: string): RangeBounds;
export declare function lineAtPosition(position: number, text: string): RangeBounds;
export declare function linesTouching(selection: RangeBounds, text: string): RangeBounds[];
export type LineBlock = Pick<BlockRange, 'type' | 'level'> | null;
export interface BlockWriter {
    setBlock(type: BlockType, level: number, paragraphStart: number, paragraphEnd: number): void;
    removeBlock(paragraphStart: number, paragraphEnd: number): void;
    rewriteLines(lines: readonly RangeBounds[], blockFor: (line: RangeBounds, existing: BlockRange | null) => LineBlock): void;
    adjustForEdit(editLocation: number, deletedLength: number, insertedLength: number): void;
    pruneOrphanedAnchors(): void;
}
export declare class BlockStore {
    private ranges;
    get allRanges(): readonly BlockRange[];
    get isEmpty(): boolean;
    setRanges(newRanges: BlockRange[]): void;
    clearAll(): void;
    edit(text: string, writes: (writer: BlockWriter) => void): void;
    private setBlock;
    private removeBlock;
    private rewriteLines;
    private pruneOrphanedAnchors;
    private normalizeToLineBounds;
    private recomputeListMetadata;
    private overlapWindow;
    private adjustForEdit;
    blockAt(position: number, text: string): BlockRange | null;
    blockStartingAt(lineStart: number): BlockRange | null;
}
//# sourceMappingURL=BlockStore.d.ts.map