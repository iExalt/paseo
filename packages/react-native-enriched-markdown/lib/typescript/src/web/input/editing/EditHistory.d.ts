import { type BlockRange } from '../model/blocks';
import { type FormattingRange } from '../model/inlineStyles';
import type { RangeBounds } from '../model/rangeBounds';
import type { TextEdit } from '../model/textEdit';
export interface ModelSnapshot {
    formatting: readonly FormattingRange[];
    blocks: readonly BlockRange[];
    selection: RangeBounds;
    backward: boolean;
}
export type EditKind = 'typing' | 'deleting' | 'composition' | 'other';
export interface HistoryState {
    canUndo: boolean;
    canRedo: boolean;
}
export declare const GROUP_INTERVAL_MS = 500;
export declare const MAX_HISTORY_DEPTH = 100;
export declare class EditHistory {
    private readonly now;
    private readonly maxDepth;
    private undoStack;
    private redoStack;
    private open;
    private discardable;
    constructor(now?: () => number, maxDepth?: number);
    get canUndo(): boolean;
    get canRedo(): boolean;
    get state(): HistoryState;
    record(edit: TextEdit, kind: EditKind, captureBefore: () => ModelSnapshot, caret?: number): void;
    recordFormatting(captureBefore: () => ModelSnapshot): void;
    discardFormatting(): void;
    breakGroup(): void;
    undo(captureAfter: () => ModelSnapshot): {
        edits: readonly TextEdit[];
        target: ModelSnapshot;
    } | null;
    redo(): {
        edits: readonly TextEdit[];
        target: ModelSnapshot;
    } | null;
    clear(): void;
    private push;
}
//# sourceMappingURL=EditHistory.d.ts.map