import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes, RootContent } from "mdast";
import { splitRunsForMatches, splitTextForMatches, type MatchPart } from "@/find-highlight/split";

/** A source range, as offsets into the Markdown text. */
export interface SourceRange {
  start: number;
  end: number;
}

/** Where one occurrence sits in the Markdown source, so the renderer can draw it. */
export type MarkdownMatch =
  | {
      kind: "inline";
      /**
       * The source the renderer draws apart to place the occurrence: its top-level
       * block from the start of its first line, or the whole message when a block
       * needs the rest of the document to render the same.
       */
      block: SourceRange;
      /** Source ranges to wrap in a highlight: text pieces, or whole code spans. */
      marks: SourceRange[];
    }
  | {
      kind: "code";
      block: SourceRange;
      code: string;
      language: string | null;
      /** The code split at its matches, numbered within the code block. */
      parts: MatchPart[];
      /** Which match in `parts` this occurrence is. */
      current: number;
    };

export interface MarkdownMatches {
  count: number;
  /** By occurrence number, in reading order. */
  matches: MarkdownMatch[];
}

interface Run {
  text: string;
  /** Source offset of each character of `text`; null where the source spells it differently. */
  offsets: (number | null)[];
  /** Set for a code span, which is highlighted whole. */
  span: SourceRange | null;
}

function parse(text: string) {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

function range(node: Nodes): SourceRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/**
 * Maps each character of a text node's value to the source character that spells it.
 * The value is the source minus syntax the reader never sees: backslash escapes,
 * container markers and indentation on continued lines. Entities decode to other
 * characters, so the first character that cannot be found ends the mapping.
 */
function valueOffsets(source: string, value: string, start: number, end: number) {
  const offsets: (number | null)[] = [];
  let cursor = start;
  for (const character of value) {
    while (cursor < end && source[cursor] !== character) cursor += 1;
    if (cursor >= end) {
      while (offsets.length < value.length) offsets.push(null);
      break;
    }
    offsets.push(cursor);
    for (let extra = 1; extra < character.length; extra += 1) offsets.push(cursor + extra);
    cursor += character.length;
  }
  return offsets;
}

/**
 * The text a reader sees in an inline container, as chat search reads it
 * (`searchableBlocks` in `@getpaseo/protocol/chat-search-text`): text and inline code,
 * line breaks as newlines, never image alt text or raw HTML.
 */
function inlineRuns(source: string, nodes: readonly Nodes[], runs: Run[]) {
  for (const node of nodes) {
    const nodeRange = range(node);
    if (node.type === "text") {
      runs.push({
        text: node.value,
        offsets: nodeRange
          ? valueOffsets(source, node.value, nodeRange.start, nodeRange.end)
          : node.value.split("").map(() => null),
        span: null,
      });
    } else if (node.type === "inlineCode") {
      runs.push({
        text: node.value,
        offsets: node.value.split("").map(() => null),
        span: nodeRange,
      });
    } else if (node.type === "break") {
      runs.push({ text: "\n", offsets: [null], span: null });
    } else if (node.type === "image" || node.type === "imageReference" || node.type === "html") {
      continue;
    } else if ("children" in node) {
      inlineRuns(source, node.children, runs);
    }
  }
}

/** Highlight ranges for one occurrence's pieces, trimmed to what a delimiter can hug. */
/** A piece of a run that a match covers; `at` is where the piece starts in its run. */
type Piece = Run & { at: number };

function markRanges(pieces: readonly Piece[], source: string): SourceRange[] {
  const marks: SourceRange[] = [];
  for (const piece of pieces) {
    if (piece.span) {
      if (!marks.some((mark) => mark.start === piece.span!.start)) marks.push(piece.span);
      continue;
    }
    // A highlight delimiter cannot sit next to whitespace, so drop the piece's edges.
    const leading = piece.text.length - piece.text.trimStart().length;
    const trimmed = piece.text.trim();
    if (!trimmed) continue;
    const first = piece.offsets[piece.at + leading];
    const last = piece.offsets[piece.at + leading + trimmed.length - 1];
    if (first === null || first === undefined || last === null || last === undefined) continue;
    // Keep a backslash escape inside the mark, or the delimiter would split it.
    const escaped = /[!-/:-@[-`{-~]/.test(source[first] ?? "") && source[first - 1] === "\\";
    marks.push({ start: escaped ? first - 1 : first, end: last + 1 });
  }
  return marks;
}

function needsWholeMessage(node: Nodes): boolean {
  if (node.type === "definition" || node.type === "html") return true;
  return "children" in node && node.children.some(needsWholeMessage);
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/**
 * Finds every occurrence chat find numbers in a message, in reading order, and where
 * the renderer draws it. Counting follows chat search's rules per searchable block, so
 * a match may span `**bold**` edges and line breaks but never two blocks. Diagrams
 * draw no text, so they hold no occurrences.
 */
export function findMarkdownMatches(text: string, pattern: RegExp): MarkdownMatches {
  const matches: MarkdownMatch[] = [];
  const tree = parse(text);
  const children = tree.children;
  // Definitions and HTML resolve against the whole message, so a part drawn apart could
  // render differently. Without definitions, a bracketed shortcut is plain text anywhere.
  const whole = children.some(needsWholeMessage) ? { start: 0, end: text.length } : null;
  children.forEach((child, index) => {
    const childRange = range(child);
    if (!childRange) return;
    const next = children[index + 1];
    const nextRange = next ? range(next) : null;
    const block = whole ?? {
      start: lineStart(text, childRange.start),
      end: nextRange ? lineStart(text, nextRange.start) : text.length,
    };
    const visit = (node: Nodes | RootContent) => {
      if (node.type === "code") {
        // The renderer draws these as diagrams (fence/mermaid/segments.ts).
        if (node.lang?.toLowerCase() === "mermaid") return;
        const parts = splitTextForMatches(node.value, pattern);
        const found = new Set(parts.flatMap((part) => (part.match === null ? [] : [part.match])));
        for (const current of [...found].sort((a, b) => a - b)) {
          // Code drawn natively cannot be marked; only a block drawn apart can.
          if (whole) {
            matches.push({ kind: "inline", block, marks: [] });
            continue;
          }
          matches.push({
            kind: "code",
            block,
            code: node.value,
            language: node.lang ?? null,
            parts,
            current,
          });
        }
        return;
      }
      if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
        const runs: Run[] = [];
        inlineRuns(text, node.children, runs);
        const byMatch = new Map<number, Piece[]>();
        // Pieces keep their run's fields; walking them in order recovers where each starts.
        let run: Run | null = null;
        let at = 0;
        for (const piece of splitRunsForMatches(runs, pattern)) {
          if (piece.offsets !== run?.offsets) {
            run = piece;
            at = 0;
          }
          if (piece.match !== null) {
            const list = byMatch.get(piece.match) ?? [];
            list.push({ ...piece, at });
            byMatch.set(piece.match, list);
          }
          at += piece.text.length;
        }
        for (const [, matchPieces] of [...byMatch].sort(([a], [b]) => a - b)) {
          matches.push({ kind: "inline", block, marks: markRanges(matchPieces, text) });
        }
        return;
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(child);
  });
  return { count: matches.length, matches };
}

/**
 * Text node characters that would read as highlight delimiters once the renderer
 * parses `==`, so they can be escaped while one occurrence is highlighted.
 */
function equalsSigns(text: string): number[] {
  const offsets: number[] = [];
  const visit = (node: Nodes) => {
    const nodeRange = range(node);
    if (node.type === "text" && nodeRange) {
      valueOffsets(text, node.value, nodeRange.start, nodeRange.end).forEach((offset, index) => {
        if (offset !== null && node.value[index] === "=" && text[offset - 1] !== "\\") {
          offsets.push(offset);
        }
      });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parse(text));
  return offsets;
}

/**
 * The Markdown with `marks` wrapped in highlight delimiters (`==`), for a renderer that
 * parses them. Every other `=` in text is escaped, so only the marks highlight.
 */
export function highlightMarkdown(text: string, marks: readonly SourceRange[]): string {
  const edits: { at: number; text: string }[] = [];
  for (const offset of equalsSigns(text)) edits.push({ at: offset, text: "\\" });
  for (const mark of marks) {
    edits.push({ at: mark.start, text: "==" });
    edits.push({ at: mark.end, text: "==" });
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  }
  return result;
}
