import type { MarkdownTextInputStyle } from '../../../types/MarkdownTextInputStyle';
import { HEADING_BLOCK_TYPES } from '../model/blocks';
type HeadingLevelKey = (typeof HEADING_BLOCK_TYPES)[number];
export declare const inputStyleVar: {
    readonly strongColor: '--enrm-strong-color';
    readonly emColor: '--enrm-em-color';
    readonly linkColor: '--enrm-link-color';
    readonly linkBackground: '--enrm-link-bg';
    readonly linkDecoration: '--enrm-link-decoration';
    readonly linkStruckDecoration: '--enrm-link-struck-decoration';
    readonly spoilerColor: '--enrm-spoiler-color';
    readonly spoilerBackground: '--enrm-spoiler-bg';
    readonly listItemSpacing: '--enrm-list-item-spacing';
    readonly headingFontSize: (level: HeadingLevelKey) => string;
    readonly headingLineHeight: (level: HeadingLevelKey) => string;
    readonly headingFontWeight: (level: HeadingLevelKey) => string;
    readonly headingColor: (level: HeadingLevelKey) => string;
};
export declare function inputStyleVariables(style: MarkdownTextInputStyle | undefined): Record<string, string>;
export {};
//# sourceMappingURL=inputStyleVariables.d.ts.map