import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItem,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { findMatchStyles } from "@/find-highlight/match-parts";
import { overlayMatchParts, type MatchPart } from "@/find-highlight/split";
import { FONT_SIZE } from "@/styles/theme";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/visual-theme";
import { FileFindBar, useFileFind } from "../find/index.native";
import { expandRunTabs, expandTabs, sourceLineOffsets, type SourceCellSize } from "./line-layout";
import { selectSourcePresentation } from "./presentation";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
}

interface SourceLine {
  number: number;
  tokens: HighlightToken[];
}

// One line height for the style and the layout math, so offsets match what draws.
const LINE_HEIGHT = Math.round(FONT_SIZE.code * 1.45);
const GUTTER_WIDTH = 56;
// Used until the probe below measures the font as the device scales it.
const ESTIMATED_CELL: SourceCellSize = { charWidth: FONT_SIZE.code * 0.6, lineHeight: LINE_HEIGHT };
// Short enough never to wrap, so its one line is the measure.
const PROBE_TEXT = "0".repeat(20);

export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  size,
  tooLargeMessage,
}: FileSourceViewProps) {
  const presentation = selectSourcePresentation({ size, platform: "native" });
  if (presentation === "unsupported") {
    return (
      <View style={styles.unsupported} testID="file-source-too-large">
        <Text style={styles.unsupportedText}>{tooLargeMessage}</Text>
      </View>
    );
  }
  return (
    <VirtualizedSource
      content={content}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      presentation={presentation}
    />
  );
}

function VirtualizedSource({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
}: Omit<FileSourceViewProps, "size" | "theme" | "tooLargeMessage"> & {
  presentation: "highlighted" | "plain";
}) {
  const listRef = useRef<FlatList<SourceLine>>(null);
  // Tabs are expanded once here, so the drawn text, the layout model and find's match
  // offsets all read the same characters.
  const texts = useMemo(() => content.split("\n").map((line) => expandTabs(line)), [content]);
  const lines = useMemo(() => {
    if (presentation === "highlighted")
      return highlightCode(content, filename).map((tokens, index) => ({
        number: index + 1,
        tokens: expandRunTabs(tokens),
      }));
    return texts.map((text, index) => ({ number: index + 1, tokens: [{ text, style: null }] }));
  }, [content, filename, presentation, texts]);

  // Lines wrap, so each row's height comes from the text width and the measured cell.
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [cell, setCell] = useState<SourceCellSize | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  const handleProbeLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    const line = event.nativeEvent.lines[0];
    if (line) setCell({ charWidth: line.width / PROBE_TEXT.length, lineHeight: line.height });
  }, []);
  const measured = viewport.width > 0 && cell !== null;
  const offsets = useMemo(
    () => sourceLineOffsets(texts, viewport.width - GUTTER_WIDTH, cell ?? ESTIMATED_CELL),
    [cell, texts, viewport.width],
  );
  const getItemLayout = useCallback(
    (_data: ArrayLike<SourceLine> | null | undefined, index: number) => ({
      length: offsets[index + 1]! - offsets[index]!,
      offset: offsets[index]!,
      index,
    }),
    [offsets],
  );
  const scrollToLine = useCallback(
    (line: number) => {
      const index = Math.max(0, Math.min(line, lines.length - 1));
      const height = offsets[index + 1]! - offsets[index]!;
      listRef.current?.scrollToOffset({
        offset: Math.max(0, offsets[index]! + height / 2 - viewport.height / 2),
        animated: false,
      });
    },
    [lines.length, offsets, viewport.height],
  );

  // Jump once per navigation, after the layout it depends on is measured.
  const jumpedRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!location.lineStart || !measured || jumpedRevision.current === navigationRevision) return;
    jumpedRevision.current = navigationRevision;
    scrollToLine(location.lineStart - 1);
  }, [location.lineStart, measured, navigationRevision, scrollToLine]);

  const find = useFileFind({ texts, path: location.path, onReveal: scrollToLine });
  const renderItem = useCallback<ListRenderItem<SourceLine>>(
    ({ item, index }) => (
      <SourceLineView
        line={item}
        parts={find.partsByLine.get(index)}
        current={find.current?.line === index ? find.current.index : -1}
      />
    ),
    [find.current, find.partsByLine],
  );

  return (
    <View style={styles.root} onLayout={handleLayout}>
      <FlatList
        ref={listRef}
        data={lines}
        keyExtractor={sourceLineKey}
        initialNumToRender={24}
        windowSize={9}
        getItemLayout={getItemLayout}
        renderItem={renderItem}
        extraData={renderItem}
      />
      <Text style={styles.probe} onTextLayout={handleProbeLayout} aria-hidden>
        {PROBE_TEXT}
      </Text>
      <FileFindBar find={find} />
    </View>
  );
}

const SourceLineView = memo(function SourceLineView({
  line,
  parts,
  current,
}: {
  line: SourceLine;
  parts: MatchPart[] | undefined;
  current: number;
}) {
  const runs = parts
    ? overlayMatchParts(line.tokens, parts)
    : line.tokens.map((token) => ({ ...token, match: null }));
  let offset = 0;
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{line.number}</Text>
      {/* The layout model wraps greedily, as the simple strategy does. */}
      <Text selectable textBreakStrategy="simple" style={styles.text}>
        {runs.map((run) => {
          const start = offset;
          offset += run.text.length;
          return (
            <Text
              key={start}
              style={[syntaxTokenStyleFor(run.style), matchStyle(run.match, current)]}
            >
              {run.text}
            </Text>
          );
        })}
      </Text>
    </View>
  );
});

function matchStyle(match: number | null, current: number) {
  if (match === null) return undefined;
  return match === current ? findMatchStyles.current : styles.match;
}

function sourceLineKey(line: SourceLine): string {
  return String(line.number);
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  unsupported: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
  line: { flexDirection: "row", minHeight: LINE_HEIGHT },
  gutter: {
    width: GUTTER_WIDTH,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: FONT_SIZE.code,
    lineHeight: LINE_HEIGHT,
  },
  text: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: FONT_SIZE.code,
    lineHeight: LINE_HEIGHT,
  },
  // Same font as the text column, out of sight, to measure one cell.
  probe: {
    position: "absolute",
    opacity: 0,
    left: 0,
    top: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: FONT_SIZE.code,
    lineHeight: LINE_HEIGHT,
  },
  match: { backgroundColor: theme.colors.statusWarningTint },
}));
