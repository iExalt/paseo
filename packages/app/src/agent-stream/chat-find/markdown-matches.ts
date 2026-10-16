import type { ASTNode } from "react-native-markdown-display";
import parser from "react-native-markdown-display/src/lib/parser";
import { isFindMarkedNode } from "@/find-highlight/markdown-nodes";
import { splitRunsForMatches, type MatchPart } from "@/find-highlight/split";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

/**
 * Where the query occurs in one assistant message as the native renderer draws it.
 * `blocks[i]` maps an AST node key of rendered block `i` to its text split at matches;
 * match numbers run across the whole message in reading order.
 */
export interface MarkdownMatches {
  count: number;
  blocks: ReadonlyMap<string, MatchPart[]>[];
}

const assistantParser = createAssistantMarkdownParser();

// The inline nodes the library promotes to blocks; markdown-it keeps them inside the
// inline run the host searches as one string.
const INLINE_BLOCK_TYPES = new Set(["hardbreak", "image", "blocklink", "textgroup"]);

interface Run {
  key: string | null;
  text: string;
}

/**
 * Groups the AST into the searchable strings of `searchableBlocks` in
 * `@getpaseo/protocol/chat-search-text`: one per paragraph-like inline run (text, inline
 * code and line breaks; image alt text never), one per code block. Keeping the host's
 * grouping keeps the count the host reported and lets a match span `**bold**` edges.
 * Diagrams are the exception: they draw no text, so they count nothing here.
 */
function collectRuns(nodes: readonly ASTNode[], groups: Run[][], current: { runs: Run[] }) {
  for (const node of nodes) {
    if (node.type === "fence" || node.type === "code_block") {
      if (isFindMarkedNode(node)) groups.push([{ key: node.key, text: node.content }]);
      continue;
    }
    if (node.type === "text" || node.type === "code_inline") {
      current.runs.push({ key: node.key, text: node.content });
      continue;
    }
    if (node.type === "softbreak" || node.type === "hardbreak") {
      current.runs.push({ key: null, text: "\n" });
      continue;
    }
    if (node.type === "image") continue;
    if (node.block === true && !INLINE_BLOCK_TYPES.has(node.type)) {
      if (current.runs.length > 0) groups.push(current.runs);
      current.runs = [];
      collectRuns(node.children, groups, current);
      if (current.runs.length > 0) groups.push(current.runs);
      current.runs = [];
      continue;
    }
    collectRuns(node.children, groups, current);
  }
}

function blockAst(block: string): ASTNode[] {
  return parser(block, (ast) => ast, assistantParser);
}

/** Pre-pass over the renderer's own parse; `text` is the text the message renders. */
export function findMarkdownMatches(text: string, pattern: RegExp): MarkdownMatches {
  let count = 0;
  const blocks = splitMarkdownBlocks(text).map((block) => {
    const groups: Run[][] = [];
    const current = { runs: [] as Run[] };
    collectRuns(blockAst(block), groups, current);
    if (current.runs.length > 0) groups.push(current.runs);
    const parts = new Map<string, MatchPart[]>();
    for (const group of groups) {
      let last = -1;
      for (const piece of splitRunsForMatches(group, pattern)) {
        if (piece.match !== null) last = Math.max(last, piece.match);
        if (piece.key === null) continue;
        const match = piece.match === null ? null : count + piece.match;
        const nodeParts = parts.get(piece.key);
        if (nodeParts) nodeParts.push({ text: piece.text, match });
        else parts.set(piece.key, [{ text: piece.text, match }]);
      }
      count += last + 1;
    }
    return parts;
  });
  return { count, blocks };
}
