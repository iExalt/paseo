import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  Text,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextLayoutLine,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { HighlightToken } from "@getpaseo/highlight";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";
import { codeBlockLanguageName } from "@/components/markdown/code-block-language";
import { useChatFindAnchorText, type ChatFindAnchorTarget } from "@/agent-stream/chat-find/anchor";
import { findMatchStyles, matchPartsOffset } from "@/find-highlight/match-parts";
import { findRevealDelta, monospaceRangeX } from "@/find-highlight/reveal";
import { overlayMatchParts, type MatchPart } from "@/find-highlight/split";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  /** Chat find's selected occurrence in this block, over the unstripped code. */
  findMatch?: CodeFindMatch | null;
  /**
   * Draws native Markdown's code block chrome (header, divider, insets) while find
   * marks this block natively, so swapping it in for the native block keeps its height.
   */
  matchNativeBlock?: boolean;
}

export interface CodeFindMatch {
  parts: readonly MatchPart[];
  current: number;
  /** Set when this block draws the occurrence reveal scrolls to. */
  anchor?: ChatFindAnchorTarget | null;
}

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
  findMatch,
  matchNativeBlock = false,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );

  const keyedLines = useMemo<KeyedLine[] | null>(
    () => highlightToKeyedLines(renderedCode, fenceLanguageToExtension(language)),
    [renderedCode, language],
  );

  const anchorText = useChatFindAnchorText(findMatch?.anchor ?? null);
  const anchorTextLayout = findMatch?.anchor ? anchorText.onTextLayout : undefined;
  // Native Markdown draws code blocks unwrapped in a pane that scrolls sideways. The
  // find block does the same, so swapping it in does not change the block's height.
  const frame = useMemo(
    () =>
      isNative && findMatch && matchNativeBlock
        ? nativeBlockFrame(inheritedStyles, textStyle)
        : null,
    [findMatch, inheritedStyles, matchNativeBlock, textStyle],
  );
  const scroller = useFindCodeScroller(isNative ? findMatch : null, textStyle, frame);
  const handleTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      anchorTextLayout?.(event);
      scroller?.onTextLayout(event);
    },
    [anchorTextLayout, scroller],
  );
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const getCode = useCallback(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);

  const text = (
    <Text
      ref={findMatch?.anchor ? anchorText.textRef : undefined}
      style={innerTextStyle}
      dataSet={markdownCopyDataSet.code}
      onTextLayout={anchorTextLayout || scroller ? handleTextLayout : undefined}
    >
      {renderCode(keyedLines, renderedCode, findMatch)}
    </Text>
  );

  return (
    <View
      style={scroller ? [containerStyle, scroller.containerStyle] : containerStyle}
      dataSet={copyDataSet}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {frame ? <NativeBlockHeader frame={frame} language={language} getCode={getCode} /> : null}
      {scroller ? (
        <View>
          <ScrollView
            ref={scroller.scrollRef}
            horizontal
            showsHorizontalScrollIndicator
            contentContainerStyle={scroller.contentStyle}
            onLayout={scroller.onLayout}
            onScroll={scroller.onScroll}
            scrollEventThrottle={16}
          >
            {text}
          </ScrollView>
          {frame ? <View style={[frameStyles.divider, { top: frame.inset / 2 }]} /> : null}
        </View>
      ) : (
        text
      )}
      {frame ? null : <CopyButton getCode={getCode} visible={controlsVisible} />}
    </View>
  );
});

// Keeps the selected occurrence this far from the pane's edges.
const FIND_SCROLL_MARGIN = 24;

/**
 * Scrolls the find block's pane sideways to the selected occurrence. Its horizontal
 * padding moves inside the pane, as in the native block, so code scrolls to the border.
 */
function useFindCodeScroller(
  findMatch: CodeFindMatch | null | undefined,
  textStyle: TextStyle,
  frame: NativeBlockFrame | null,
) {
  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(0);
  const [lines, setLines] = useState<readonly TextLayoutLine[]>([]);
  const [paneWidth, setPaneWidth] = useState(0);
  const enabled = !!findMatch;
  const range = useMemo(() => {
    if (!findMatch) return null;
    const start = matchPartsOffset(findMatch.parts, findMatch.current);
    let length = 0;
    for (const part of findMatch.parts) {
      if (part.match === findMatch.current) length += part.text.length;
    }
    return { start, end: start + length };
  }, [findMatch]);
  const padding = textStyle.paddingHorizontal ?? textStyle.padding;
  let inset = typeof padding === "number" ? padding : 0;
  if (frame) inset = frame.inset - frame.borderWidth;

  useEffect(() => {
    if (!range || paneWidth === 0) return;
    const match = monospaceRangeX(lines, range.start, range.end);
    if (!match) return;
    const delta = findRevealDelta({
      visibleTop: scrollX.current,
      visibleBottom: scrollX.current + paneWidth,
      matchTop: inset + match.x,
      matchHeight: match.width,
      margin: FIND_SCROLL_MARGIN,
    });
    if (delta === 0) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, scrollX.current + delta), animated: false });
  }, [inset, lines, paneWidth, range]);

  const onTextLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    setLines(event.nativeEvent.lines);
  }, []);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setPaneWidth(event.nativeEvent.layout.width);
  }, []);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = event.nativeEvent.contentOffset.x;
  }, []);
  // The native pane spans the block's width and starts below the header; its text keeps
  // the block's inset, less the bottom border the pane is clipped by.
  const containerStyle = useMemo<ViewStyle>(
    () => (frame ? { padding: 0 } : { paddingHorizontal: 0 }),
    [frame],
  );
  const contentStyle = useMemo<ViewStyle>(
    () =>
      frame
        ? {
            paddingHorizontal: inset,
            paddingTop: frame.inset,
            paddingBottom: frame.inset - frame.borderWidth,
          }
        : { paddingHorizontal: inset },
    [frame, inset],
  );

  return useMemo(
    () =>
      enabled
        ? { scrollRef, onTextLayout, onLayout, onScroll, containerStyle, contentStyle }
        : null,
    [enabled, onTextLayout, onLayout, onScroll, containerStyle, contentStyle],
  );
}

function renderCodeSegments(keyedLines: KeyedLine[]): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < keyedLines.length; lineIndex += 1) {
    const line = keyedLines[lineIndex];
    if (lineIndex > 0) {
      segments.push(<CodeTextSpan key={`${line.key}-newline`} text={"\n"} />);
    }
    for (const { key, token } of line.tokens) {
      segments.push(<TokenSpan key={`${line.key}-${key}`} token={token} />);
    }
  }
  return segments;
}

function renderCode(
  keyedLines: KeyedLine[] | null,
  code: string,
  findMatch: CodeFindMatch | null | undefined,
): React.ReactNode {
  if (findMatch) return renderFindSegments(keyedLines, code, findMatch);
  return keyedLines ? renderCodeSegments(keyedLines) : code;
}

/** The code cut at the selected match; only the block holding it renders this way. */
function renderFindSegments(
  keyedLines: KeyedLine[] | null,
  code: string,
  findMatch: CodeFindMatch,
): React.ReactNode[] {
  const runs: { text: string; style: HighlightToken["style"] | null }[] = keyedLines
    ? keyedLines.flatMap((line, lineIndex) => [
        ...(lineIndex > 0 ? [{ text: "\n", style: null }] : []),
        ...line.tokens.map(({ token }) => ({ text: token.text, style: token.style ?? null })),
      ])
    : [{ text: code, style: null }];
  let offset = 0;
  return overlayMatchParts(runs, findMatch.parts).map((run) => {
    const start = offset;
    offset += run.text.length;
    return (
      <Text
        key={start}
        style={[
          run.style ? syntaxTokenStyleFor(run.style) : undefined,
          run.match === findMatch.current ? findMatchStyles.current : undefined,
        ]}
      >
        {run.text}
      </Text>
    );
  });
}

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  return (
    <Text style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>{token.text}</Text>
  );
});

interface CodeTextSpanProps {
  text: string;
}

const CodeTextSpan = React.memo(function CodeTextSpan({ text }: CodeTextSpanProps) {
  return <Text>{text}</Text>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CopyButtonProps {
  getCode: () => string;
  visible: boolean;
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({
  getCode,
  visible,
  iconSize = 14,
  style,
}: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  const visibilityStyle = visible
    ? copyButtonStyles.containerVisible
    : copyButtonStyles.containerHidden;
  const wrapperStyle = useMemo(
    () => [copyButtonStyles.container, visibilityStyle, style],
    [style, visibilityStyle],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyCode")}
      hitSlop={8}
      dataSet={markdownCopyDataSet.ignore}
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? copyButtonStyles.iconHoveredColor.color
          : copyButtonStyles.iconColor.color;
        return copied ? (
          <Check size={iconSize} color={iconColor} />
        ) : (
          <Copy size={iconSize} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const copyButtonStyles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  containerVisible: {
    opacity: 1,
  },
  containerHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

/**
 * react-native-enriched-markdown's code block header metrics (CodeBlockContainerView.kt,
 * ENRMCodeBlockContainerView.m). The header is the content inset plus one label line, with
 * the label and copy button centred above a divider halfway into the code's top inset.
 */
interface NativeBlockFrame {
  inset: number;
  borderWidth: number;
  labelFontSize: number;
  iconSize: number;
}

const NATIVE_HEADER_LABEL_SCALE = 0.85;
const NATIVE_HEADER_ICON_SCALE = 1.08;

function nativeBlockFrame(inheritedStyles: TextStyle, textStyle: TextStyle): NativeBlockFrame {
  const borderWidth = textStyle.borderWidth ?? 0;
  const padding = typeof textStyle.padding === "number" ? textStyle.padding : 0;
  const fontSize = inheritedStyles.fontSize ?? 14;
  return {
    inset: Math.ceil(padding + borderWidth),
    borderWidth,
    labelFontSize: fontSize * NATIVE_HEADER_LABEL_SCALE,
    iconSize: Math.round(fontSize * NATIVE_HEADER_ICON_SCALE),
  };
}

interface NativeBlockHeaderProps {
  frame: NativeBlockFrame;
  language: string | null | undefined;
  getCode: () => string;
}

function NativeBlockHeader({ frame, language, getCode }: NativeBlockHeaderProps) {
  const { inset, borderWidth } = frame;
  // The border is drawn outside this view, so it comes off the top padding. A
  // non-breaking space keeps the label's line height when there is no language.
  const headerStyle = useMemo<ViewStyle>(
    () => ({
      paddingTop: inset * 0.75 - borderWidth,
      paddingBottom: inset * 0.25,
      paddingLeft: inset - borderWidth,
      paddingRight: inset - borderWidth + frame.iconSize,
    }),
    [borderWidth, frame.iconSize, inset],
  );
  const labelStyle = useMemo(
    () => [frameStyles.label, { fontSize: frame.labelFontSize }],
    [frame.labelFontSize],
  );
  const buttonStyle = useMemo<ViewStyle>(
    () => ({
      top: inset / 2 - borderWidth,
      bottom: 0,
      right: inset - borderWidth,
      padding: 0,
      justifyContent: "center",
    }),
    [borderWidth, inset],
  );
  return (
    <View style={headerStyle}>
      <Text style={labelStyle} numberOfLines={1}>
        {codeBlockLanguageName(language) || "\u00a0"}
      </Text>
      <CopyButton getCode={getCode} visible iconSize={frame.iconSize} style={buttonStyle} />
    </View>
  );
}

const frameStyles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foreground,
    opacity: 0.6,
    fontWeight: "500",
    includeFontPadding: false,
  },
  divider: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: theme.colors.foreground,
    opacity: 0.2,
  },
}));
