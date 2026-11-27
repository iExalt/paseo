import { type BlockStore } from '../formatting/BlockStore';
import { type BlockType } from '../model/blocks';
import type { RangeBounds } from '../model/rangeBounds';
export declare class BlockEditCoordinator {
    private readonly blockStore;
    constructor(blockStore: BlockStore);
    changeListDepthBy(delta: number, selection: RangeBounds, text: string): boolean;
    private listDepthAt;
    toggleHeading(level: number, selection: RangeBounds, text: string): boolean;
    toggleListType(type: BlockType, selection: RangeBounds, text: string): void;
}
//# sourceMappingURL=BlockEditCoordinator.d.ts.map