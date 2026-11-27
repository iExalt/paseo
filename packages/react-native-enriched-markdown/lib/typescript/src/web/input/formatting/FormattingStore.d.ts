import type { FormattingRange, InputStyleType } from '../model/inlineStyles';
import type { RangeBounds } from '../model/rangeBounds';
export declare class FormattingStore {
    private ranges;
    private revision;
    get version(): number;
    get allRanges(): readonly FormattingRange[];
    setRanges(ranges: FormattingRange[]): void;
    clearAll(): void;
    rangesOfType(type: InputStyleType): FormattingRange[];
    rangeOfType(type: InputStyleType, position: number): FormattingRange | null;
    isStyleActive(type: InputStyleType, position: number): boolean;
    isStyleActiveInRange(type: InputStyleType, start: number, end: number): boolean;
    isStyleAdjacentBefore(type: InputStyleType, position: number): boolean;
    isStyleFullyActive(type: InputStyleType, start: number, end: number, text?: string): boolean;
    addRange(newRange: FormattingRange): void;
    removeType(type: InputStyleType, start: number, end: number): void;
    toggleStyle(type: InputStyleType, start: number, end: number, text?: string): boolean;
    isToggleBlocked(type: InputStyleType, position: number, blockingStyles: ReadonlySet<InputStyleType>): boolean;
    selectionAdjustedForAtomicLinks(start: number, end: number, previousCaret?: number | null): RangeBounds | null;
    adjustForEdit(editLocation: number, deletedLength: number, insertedLength: number): void;
    removeRange(range: FormattingRange): void;
    private coalesceAdjacentSameTypeRanges;
    private insertSorted;
}
//# sourceMappingURL=FormattingStore.d.ts.map