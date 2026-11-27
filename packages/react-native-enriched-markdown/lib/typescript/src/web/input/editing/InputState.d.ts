import type { BlockStore } from '../formatting/BlockStore';
import type { FormattingStore } from '../formatting/FormattingStore';
import type { RangeBounds } from '../model/rangeBounds';
import type { TypingAttributesController } from './TypingAttributesController';
export interface InputState {
    bold: {
        isActive: boolean;
    };
    italic: {
        isActive: boolean;
    };
    underline: {
        isActive: boolean;
    };
    strikethrough: {
        isActive: boolean;
    };
    spoiler: {
        isActive: boolean;
    };
    link: {
        isActive: boolean;
        destination: string;
    };
    heading: {
        isActive: boolean;
        level: number;
    };
    unorderedList: {
        isActive: boolean;
        depth: number;
    };
    orderedList: {
        isActive: boolean;
        depth: number;
    };
}
export declare function buildInputState(formattingStore: FormattingStore, blockStore: BlockStore, typing: TypingAttributesController, selection: RangeBounds, text: string): InputState;
export declare function sameInputState(a: InputState, b: InputState): boolean;
export declare function copyInputState(state: InputState): InputState;
//# sourceMappingURL=InputState.d.ts.map