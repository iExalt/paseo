import { type BlockStore } from '../formatting/BlockStore';
import type { FormattingStore } from '../formatting/FormattingStore';
import { type PendingStyleType } from '../model/inlineStyles';
import type { TextEdit } from '../model/textEdit';
export interface EditContext extends TextEdit {
    pendingStyles: readonly PendingStyleType[];
    pendingStyleRemovals: readonly PendingStyleType[];
}
export declare class EditPipeline {
    private readonly formattingStore;
    private readonly blockStore;
    constructor(formattingStore: FormattingStore, blockStore: BlockStore);
    processTextChange(text: string, context: EditContext): void;
    private continueBlockOnNewline;
    private applyPendingStyles;
}
//# sourceMappingURL=EditPipeline.d.ts.map