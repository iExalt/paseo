import { memo, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { ChatFindAnchorTarget } from "@/agent-stream/chat-find/anchor";
import { matchPartsOffset } from "@/find-highlight/match-parts";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import type { FindCode } from "./find-split";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);

// Matches the native renderer's code block (markdown/styles.ts) so the block does not
// shift while find marks it.
const codeBlockStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily:
      theme.fontFamily.mono === "ui-monospace" && !isWeb ? undefined : theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: theme.spacing[3],
  },
});

/** A code block drawn in JS so it can mark the occurrence and measure its line. */
export const FindCodeBlock = memo(function FindCodeBlock({
  code,
  language,
  parts,
  current,
  anchor,
}: FindCode & { anchor: ChatFindAnchorTarget }) {
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
      uniProps={codeBlockStyle}
    />
  );
});
