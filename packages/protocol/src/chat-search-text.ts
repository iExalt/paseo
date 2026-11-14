/**
 * What chat find searches, shared by the daemon's search and the native client so both
 * count the same occurrences. Markdown is parsed by the caller (markdown-it with
 * `html: false`); this module only reads its token stream.
 */
export interface ChatSearchToken {
  type: string;
  content: string;
  children?: readonly ChatSearchToken[] | null;
}

/**
 * The text a reader sees, one entry per block. The Markdown source is never searched
 * whole, because a match across a block boundary or on syntax the reader never sees
 * cannot be highlighted.
 */
export function searchableBlocks(tokens: readonly ChatSearchToken[]): string[] {
  return tokens
    .map((token) => {
      if (token.type === "inline") {
        return (token.children ?? [])
          .map((child) => {
            if (child.type === "text" || child.type === "code_inline") return child.content;
            if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
            return "";
          })
          .join("");
      }
      if (token.type === "fence" || token.type === "code_block") return token.content;
      return "";
    })
    .filter(Boolean);
}

/** Case-insensitive, with any run of whitespace in the query matching any run in the text. */
export function searchPattern(query: string): RegExp {
  const source = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(source, "giu");
}

export function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}
