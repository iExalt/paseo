import type { FormattingStore } from '../formatting/FormattingStore';
import { type InputStyleType, type PendingStyleType } from '../model/inlineStyles';
import type { RangeBounds } from '../model/rangeBounds';
export declare class TypingAttributesController {
    private readonly formattingStore;
    private readonly pendingStyles;
    private readonly pendingStyleRemovals;
    constructor(formattingStore: FormattingStore);
    get styles(): PendingStyleType[];
    get styleRemovals(): PendingStyleType[];
    isEffectiveStyleActive(type: InputStyleType, position: number): boolean;
    toggleStyle(type: PendingStyleType, caret: number): void;
    resetForSelectionChange(selection: RangeBounds): void;
}
//# sourceMappingURL=TypingAttributesController.d.ts.map