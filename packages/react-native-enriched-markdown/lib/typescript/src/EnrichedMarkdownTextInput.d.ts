import type React from 'react';
import { type OnKeyPressEvent, type OnLinkDetected, type OnStartMentionEvent, type OnChangeMentionEvent, type OnEndMentionEvent } from './EnrichedMarkdownTextInputNativeComponent';
export type { OnKeyPressEvent, OnLinkDetected, OnStartMentionEvent, OnChangeMentionEvent, OnEndMentionEvent, } from './EnrichedMarkdownTextInputNativeComponent';
import type { HostInstance, NativeSyntheticEvent, TextInputProps, ViewProps, TextStyle, StyleProp, ColorValue } from 'react-native';
import type { RefObject } from 'react';
import type { CaretRect, HeadingLevel, HistoryState, MarkdownTextInputInstance, StyleState } from './types/MarkdownTextInputInstance';
import type { HeadingStyle, LinkStyle, MarkdownTextInputStyle } from './types/MarkdownTextInputStyle';
export type { HeadingLevel, HistoryState, StyleState, CaretRect };
export type { HeadingStyle, LinkStyle, MarkdownTextInputStyle };
export type EnrichedMarkdownTextInputInstance = MarkdownTextInputInstance<HostInstance>;
export interface ContextMenuItem {
    text: string;
    onPress: (event: {
        text: string;
        selection: {
            start: number;
            end: number;
        };
        styleState: StyleState;
    }) => void;
    icon?: string;
    visible?: boolean;
}
/**
 * Per-item shape: `{ enabled }` toggles visibility, `label` overrides the
 * English default. Wire `label` to your i18n library to localize the menu.
 */
type MenuItem = {
    enabled?: boolean;
    label?: string;
};
export interface InputSelectionMenuConfig {
    /**
     * The built-in "Format" submenu (Bold, Italic, Underline, etc.) in the
     * text selection context menu. `label` overrides the submenu title.
     * @default { enabled: true, label: "Format" }
     */
    format?: MenuItem;
    /**
     * The built-in "Copy as Markdown" action in the text selection context
     * menu. `label` overrides the action title.
     * @default { enabled: true, label: "Copy as Markdown" }
     */
    copyAsMarkdown?: MenuItem;
}
/** Controls the individual items inside the Format submenu. */
export interface FormatMenuConfig {
    /** @default { enabled: true, label: "Bold" } */
    bold?: MenuItem;
    /** @default { enabled: true, label: "Italic" } */
    italic?: MenuItem;
    /** @default { enabled: true, label: "Underline" } */
    underline?: MenuItem;
    /** @default { enabled: true, label: "Strikethrough" } */
    strikethrough?: MenuItem;
    /** @default { enabled: true, label: "Spoiler" } */
    spoiler?: MenuItem;
    /** @default { enabled: true, label: "Link" } */
    link?: MenuItem;
}
/**
 * Which typed markdown block prefixes convert into blocks. An omitted key is
 * off, so `{ heading: true }` enables headings and nothing else.
 */
export interface MarkdownShortcutsConfig {
    /** `#`–`######` + space. @default false */
    heading?: boolean;
    /** `-`/`*`/`+` + space. @default false */
    unorderedList?: boolean;
    /** `1.` or `1)` + space. @default false */
    orderedList?: boolean;
}
export interface EnrichedMarkdownTextInputProps extends Omit<ViewProps, 'style' | 'children'>, Pick<TextInputProps, 'onPress' | 'onPressIn' | 'onPressOut' | 'rejectResponderTermination'> {
    ref?: RefObject<EnrichedMarkdownTextInputInstance | null>;
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: ColorValue;
    editable?: boolean;
    autoFocus?: boolean;
    scrollEnabled?: boolean;
    /**
     * Converts markdown block prefixes typed at the start of a paragraph into
     * blocks, the way Notion, Bear and Obsidian do: `#`–`######` + space becomes
     * a heading, `-`/`*`/`+` + space a bullet item, `1.` (or `1)`) + space a
     * numbered item. The prefix and its space are removed from the text.
     * `true` enables all three; pass a {@link MarkdownShortcutsConfig} to enable
     * a subset. Off by default so apps that treat `#` or `-` as literal text
     * (tags, dashes) see no change.
     * @default false
     */
    markdownShortcuts?: boolean | MarkdownShortcutsConfig;
    autoCapitalize?: string;
    multiline?: boolean;
    cursorColor?: ColorValue;
    selectionColor?: ColorValue;
    markdownStyle?: MarkdownTextInputStyle;
    style?: StyleProp<TextStyle>;
    onChangeText?: (text: string) => void;
    onChangeMarkdown?: (markdown: string) => void;
    onChangeSelection?: (selection: {
        start: number;
        end: number;
    }) => void;
    onChangeState?: (state: StyleState) => void;
    /**
     * Whether `undo()` and `redo()` have a step to take. Web-only for now:
     * never called on iOS and Android.
     */
    onChangeHistoryState?: (state: HistoryState) => void;
    onKeyPress?: (e: NativeSyntheticEvent<OnKeyPressEvent>) => void;
    onCaretRectChange?: (rect: CaretRect) => void;
    onLinkDetected?: (event: OnLinkDetected) => void;
    mentionIndicators?: string[];
    onStartMention?: (event: OnStartMentionEvent) => void;
    onChangeMention?: (event: OnChangeMentionEvent) => void;
    onEndMention?: (event: OnEndMentionEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    contextMenuItems?: ContextMenuItem[];
    /**
     * Controls built-in items in the text selection context menu.
     * Omitting the prop or any field reproduces today's exact menu.
     * Custom app-provided actions are controlled separately via `contextMenuItems`.
     * @default { format: true, copyAsMarkdown: true }
     * @platform ios, android, macos
     */
    selectionMenuConfig?: InputSelectionMenuConfig;
    /**
     * Controls which items appear inside the Format submenu.
     * Only effective when `selectionMenuConfig.format` is `true` (the default).
     * Omitting the prop or any field shows all items.
     * @default { bold: true, italic: true, underline: true, strikethrough: true, spoiler: true, link: true }
     * @platform ios, android, macos
     */
    formatMenuConfig?: FormatMenuConfig;
    linkRegex?: RegExp | null;
    /**
     * Paragraph writing direction.
     * - `'first-strong'` (default): resolves each paragraph from its first strong
     *   directional character. Neutral-only paragraphs fall back to the view's
     *   resolved layout direction (inherits ancestor `direction` style). Library
     *   extension — matches Android's `TEXT_DIRECTION_FIRST_STRONG`.
     * - `'auto'`: React Native parity. iOS TextKit follows the app's
     *   `userInterfaceLayoutDirection`; mixed-direction paragraphs do not
     *   auto-resolve.
     * - `'ltr'` / `'rtl'`: force base direction on every paragraph.
     *
     * Android ignores this prop; the platform's `EditText` always uses
     * `TEXT_DIRECTION_FIRST_STRONG` per paragraph.
     * @default 'first-strong'
     * @platform ios
     */
    writingDirection?: 'auto' | 'ltr' | 'rtl' | 'first-strong';
}
export declare const EnrichedMarkdownTextInput: ({ ref, markdownStyle, style, defaultValue, placeholder, placeholderTextColor, editable, autoFocus, scrollEnabled, markdownShortcuts, autoCapitalize, multiline, cursorColor, selectionColor, onChangeText, onChangeMarkdown, onChangeSelection, onChangeState, onChangeHistoryState, onKeyPress, onCaretRectChange, onLinkDetected, mentionIndicators, onStartMention, onChangeMention, onEndMention, onFocus, onBlur, onPress, onPressIn, onPressOut, hitSlop, rejectResponderTermination, contextMenuItems, selectionMenuConfig, formatMenuConfig, linkRegex: _linkRegex, writingDirection, ...rest }: EnrichedMarkdownTextInputProps) => React.JSX.Element;
export default EnrichedMarkdownTextInput;
//# sourceMappingURL=EnrichedMarkdownTextInput.d.ts.map