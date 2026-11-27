import type { BlockRange, BlockType } from '../model/blocks';
import { type FormattingRange, type InputStyleType } from '../model/inlineStyles';
export interface StyleRun {
    startInLine: number;
    endInLine: number;
    styles: InputStyleType[];
    url?: string;
}
export declare function sameRunStyle(run: StyleRun, styles: InputStyleType[], url?: string): boolean;
export declare function computeStyleRuns(ranges: readonly FormattingRange[], lineStart: number, lineEnd: number): StyleRun[];
export interface ParagraphProjection {
    readonly text: string;
    readonly blockType: BlockType;
    readonly level: number;
    readonly ordinal: number;
    readonly runs: readonly StyleRun[];
}
export interface Projection {
    readonly paragraphs: readonly ParagraphProjection[];
    readonly lineStarts: readonly number[];
}
export declare function projectParagraphs(text: string, formattingRanges: readonly FormattingRange[], blockRanges: readonly BlockRange[]): Projection;
export interface ProjectedFormatting {
    readonly allRanges: readonly FormattingRange[];
    readonly version: number;
}
export declare class ParagraphProjector {
    private readonly formatting;
    private paragraphs;
    private lineStarts;
    private text;
    private formattingVersion;
    constructor(formatting: ProjectedFormatting);
    invalidate(): void;
    textEdited(editStart: number, deletedLength: number, insertedText: string, text: string): void;
    stylesChanged(start: number, end: number): void;
    project(text: string, blockRanges: readonly BlockRange[]): Projection;
    private startOver;
    private lineIndexAt;
}
//# sourceMappingURL=InputProjection.d.ts.map