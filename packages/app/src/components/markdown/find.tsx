import { memo, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { ChatFindAnchorTarget } from "@/agent-stream/chat-find/anchor";
import { matchPartsOffset } from "@/find-highlight/match-parts";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import type { FindCode } from "./find-split";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);


/** A code block drawn in JS so it can mark the occurrence and measure its line. */
export const FindCodeBlock = memo(function FindCodeBlock({
  code,
  language,
  parts,
  current,
  anchor,
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
    />
  );
});
