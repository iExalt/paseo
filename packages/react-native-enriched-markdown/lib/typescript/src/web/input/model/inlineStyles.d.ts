import type { RangeBounds } from './rangeBounds';
export declare const INPUT_STYLE_TYPES: readonly ['strong', 'em', 'underline', 'strikethrough', 'link', 'spoiler'];
export type InputStyleType = (typeof INPUT_STYLE_TYPES)[number];
export type PendingStyleType = Exclude<InputStyleType, 'link'>;
export declare const TYPING_ATTRIBUTE_STYLES: readonly PendingStyleType[];
export interface FormattingRange extends RangeBounds {
    type: InputStyleType;
    url?: string;
}
export declare function createFormattingRange(type: InputStyleType, start: number, end: number, url?: string): FormattingRange;
//# sourceMappingURL=inlineStyles.d.ts.map