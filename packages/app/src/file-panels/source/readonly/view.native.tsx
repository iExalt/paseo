import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { FilePanelLoading } from "../../loading";
import type { SourcePresentation } from "./presentation";
import { buildSourceLines } from "./source-lines";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  presentation: Exclude<SourcePresentation, "unsupported">;
  theme: EditorVisualTheme;
}

/** Lines past the opening line highlighted before the rest of a large file. */
const FIRST_LINES = 200;

/**
 * A virtualized, read-only source view. Shows Loading until the lines around the opening line are
 * highlighted; the rest highlight in the background. A changed file keeps showing the previous
 * lines until its own are ready.
 */
export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
}: FileSourceViewProps) {
  const listRef = useRef<FlatList<HighlightToken[]>>(null);
  const [lines, setLines] = useState<HighlightToken[][] | null>(null);
  // Navigating within the file does not rebuild its lines; a new build starts at the latest line.
  const openingLine = useRef(location.lineStart);
  useEffect(() => {
    openingLine.current = location.lineStart;
  });
  useEffect(() => {
    const firstLines = (openingLine.current ?? 1) + FIRST_LINES;
    return buildSourceLines({ content, filename, presentation, firstLines }, setLines);
  }, [content, filename, presentation]);
  const lineCount = lines?.length ?? 0;
  const pendingLine = useRef<number | null>(null);
  const revealPendingLine = useCallback(() => {
    const index = pendingLine.current;
    if (index === null) return;
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  }, []);
  const handleViewableLines = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const index = pendingLine.current;
      if (index === null) return;
      revealPendingLine();
      if (viewableItems.some((row) => row.index === index)) pendingLine.current = null;
    },
    [revealPendingLine],
  );
  const cancelPendingLine = useCallback(() => {
    pendingLine.current = null;
  }, []);
  const handleUnmeasuredLine = useCallback(
    ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      pendingLine.current = index;
      listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
    },
    [],
  );
  useEffect(() => {
    if (!location.lineStart || lineCount === 0) {
      pendingLine.current = null;
      return;
    }
    pendingLine.current = Math.min(location.lineStart - 1, lineCount - 1);
    revealPendingLine();
  }, [lineCount, location.lineStart, navigationRevision, revealPendingLine]);
  if (!lines) return <FilePanelLoading />;
  return (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={sourceLineKey}
      initialNumToRender={24}
      windowSize={9}
      // Wrapped rows and font scaling need the list's measured heights.
      onScrollToIndexFailed={handleUnmeasuredLine}
      onContentSizeChange={revealPendingLine}
      onViewableItemsChanged={handleViewableLines}
      onScrollBeginDrag={cancelPendingLine}
      bounces={false}
      overScrollMode="never"
      testID="file-source-scroll"
      renderItem={renderSourceLine}
    />
  );
}

interface SourceLineProps {
  tokens: HighlightToken[];
  number: number;
}

// Finishing the highlight replaces every line; the lines already highlighted stay as they were.
const SourceLineView = memo(function SourceLineView({ tokens, number }: SourceLineProps) {
  // A token's offset in its line identifies it; its text and style can repeat.
  let offset = 0;
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{number}</Text>
      <Text selectable style={styles.text}>
        {tokens.map((token) => {
          const key = offset;
          offset += token.text.length;
          return (
            <Text key={key} style={syntaxTokenStyleFor(token.style)}>
              {token.text}
            </Text>
          );
        })}
      </Text>
    </View>
  );
}, sameSourceLine);

function sameSourceLine(previous: SourceLineProps, next: SourceLineProps): boolean {
  return (
    previous.number === next.number &&
    previous.tokens.length === next.tokens.length &&
    previous.tokens.every(
      (token, index) =>
        token.text === next.tokens[index].text && token.style === next.tokens[index].style,
    )
  );
}

function sourceLineKey(_tokens: HighlightToken[], index: number): string {
  return String(index);
}

const renderSourceLine: ListRenderItem<HighlightToken[]> = ({ item, index }) => (
  <SourceLineView tokens={item} number={index + 1} />
);

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: "row", minHeight: theme.fontSize.code * 1.45 },
  gutter: {
    width: 56,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  text: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.45,
  },
}));
