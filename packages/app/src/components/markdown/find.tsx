import { memo, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { ChatFindAnchorTarget } from "@/agent-stream/chat-find/anchor";
import { matchPartsOffset } from "@/find-highlight/match-parts";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import type { FindCode } from "./find-split";
import { createCodeBlockStyle } from "./styles";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);

// The native renderer's code block (markdown/styles.ts), so the block keeps its height
// while find marks it.
const codeBlockStyle = (theme: Theme, compact: boolean) => {
  const { fontSize, lineHeight, color, ...box } = createCodeBlockStyle(theme, compact);
  return {
    inheritedStyles: {
      color,
      fontFamily:
        theme.fontFamily.mono === "ui-monospace" && !isWeb ? undefined : theme.fontFamily.mono,
      fontSize,
      lineHeight,
    },
    textStyle: box,
  };
};
const regularStyle = (theme: Theme) => codeBlockStyle(theme, false);
const compactStyle = (theme: Theme) => codeBlockStyle(theme, true);

/** A code block drawn in JS so it can mark the occurrence and measure its line. */
export const FindCodeBlock = memo(function FindCodeBlock({
  code,
  language,
  parts,
  current,
  anchor,
  compact = false,
}: FindCode & { anchor: ChatFindAnchorTarget; compact?: boolean }) {
  const findMatch = useMemo(
    () => ({
      parts,
      current,
      anchor: { ...anchor, offset: matchPartsOffset(parts, current) },
    }),
    [anchor, current, parts],
  );
  return (
    <ThemedCodeBlock
      code={code}
      language={language}
      findMatch={findMatch}
      matchNativeBlock
      uniProps={compact ? compactStyle : regularStyle}
    />
  );
});
