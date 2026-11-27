import { type CSSProperties, type HTMLAttributes } from 'react';
import type { CaretRect, HeadingLevel, HistoryState, MarkdownTextInputInstance, MeasureCallback, MeasureInWindowCallback, MeasureLayoutCallback, StyleState } from './types/MarkdownTextInputInstance';
import type { MarkdownTextInputStyle } from './types/MarkdownTextInputStyle';
export type { CaretRect, HeadingLevel, HistoryState, MeasureCallback, MeasureInWindowCallback, MeasureLayoutCallback, StyleState, };
export type EnrichedMarkdownTextInputInstance = MarkdownTextInputInstance<Element>;
type ForwardedDomProps = Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'children' | 'dangerouslySetInnerHTML' | 'contentEditable' | 'spellCheck' | 'defaultValue' | 'onFocus' | 'onBlur'>;
export interface EnrichedMarkdownTextInputProps extends ForwardedDomProps {
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: string;
    editable?: boolean;
    autoFocus?: boolean;
    spellCheck?: boolean;
    style?: CSSProperties;
    /** Formatting colors and heading sizes. `linkVariants` is ignored on web. */
    markdownStyle?: MarkdownTextInputStyle;
    onChangeText?: (text: string) => void;
    onChangeSelection?: (selection: {
        start: number;
        end: number;
    }) => void;
    onChangeState?: (state: StyleState) => void;
    onChangeMarkdown?: (markdown: string) => void;
    onChangeHistoryState?: (state: HistoryState) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    /** Rendered as `data-testid`, as `EnrichedMarkdownText` does. */
    testID?: string;
    /** Background of selected text (`::selection`). */
    selectionColor?: string;
    /** Color of the caret (`caret-color`). */
    cursorColor?: string;
}
export declare const EnrichedMarkdownTextInput: import("react").ForwardRefExoticComponent<EnrichedMarkdownTextInputProps & import("react").RefAttributes<EnrichedMarkdownTextInputInstance>>;
//# sourceMappingURL=EnrichedMarkdownTextInput.web.d.ts.map