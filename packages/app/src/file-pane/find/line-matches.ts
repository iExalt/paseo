/** Matches counted before the status shows "+", the same cap web file find uses. */
export const FILE_FIND_MATCH_LIMIT = 10_000;

export interface LineMatch {
  line: number;
  start: number;
  end: number;
}

/** The pattern web file find uses: literal, case-insensitive, never across lines. */
export function fileFindPattern(query: string): RegExp | null {
  if (!query || /[\r\n]/.test(query)) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

/** Every match in reading order, up to the cap; `limited` says more were left uncounted. */
export function findLineMatches(
  lines: readonly string[],
  query: string,
): { matches: LineMatch[]; limited: boolean } {
  const pattern = fileFindPattern(query);
  const matches: LineMatch[] = [];
  if (!pattern) return { matches, limited: false };
  for (let line = 0; line < lines.length; line += 1) {
    for (const found of lines[line]!.matchAll(pattern)) {
      if (matches.length === FILE_FIND_MATCH_LIMIT) return { matches, limited: true };
      matches.push({ line, start: found.index, end: found.index + found[0].length });
    }
  }
  return { matches, limited: false };
}
