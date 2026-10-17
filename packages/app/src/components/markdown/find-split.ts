import type { ChatFindAnchorTarget } from "@/agent-stream/chat-find/anchor";
import { highlightMarkdown, type MarkdownMatch } from "@/agent-stream/chat-find/markdown-matches";
import { matchPartsOffset } from "@/find-highlight/match-parts";
import type { MatchPart } from "@/find-highlight/split";
/** Chat find's selected occurrence in a message, and where reveal looks for it. */
export interface MarkdownFind {
  match: MarkdownMatch;
  /** `offset` is ignored: the renderer works out where the occurrence is drawn. */
  anchor: ChatFindAnchorTarget;
}

export interface FindCode {
  code: string;
  language: string | null;
  parts: MatchPart[];
  current: number;
}

export interface MarkdownFindSplit {
  head: string;
  /** The block to draw apart, with the occurrence highlighted; empty for code. */
  block: string;
  /** Set when the occurrence is in a code block, drawn in place of `block`. */
  code: FindCode | null;
  tail: string;
  /** How far down the drawn block the occurrence starts, from 0 to 1. */
  fraction: number;
}

/** Cuts a message around the block holding the occurrence and marks it there. */
export function splitMarkdownForFind(text: string, match: MarkdownMatch): MarkdownFindSplit {
  const { start, end } = match.block;
  const head = text.slice(0, start);
  const tail = text.slice(end);
  if (match.kind === "code") {
    const { code, language, parts, current } = match;
    return {
      head,
      block: "",
      code: { code, language, parts, current },
      tail,
      fraction: code.length > 0 ? matchPartsOffset(parts, current) / code.length : 0,
    };
  }
  const source = text.slice(start, end);
  const marks = match.marks.map((mark) => ({ start: mark.start - start, end: mark.end - start }));
  const first = marks.length > 0 ? Math.min(...marks.map((mark) => mark.start)) : 0;
  return {
    head,
    block: highlightMarkdown(source, marks),
    code: null,
    tail,
    fraction: source.length > 0 ? first / source.length : 0,
  };
}
