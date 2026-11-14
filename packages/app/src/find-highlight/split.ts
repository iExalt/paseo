/** A piece of text and, when it is part of a match, that match's index in the text. */
export interface MatchPart {
  text: string;
  match: number | null;
}

function matchRanges(text: string, pattern: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  global.lastIndex = 0;
  for (const found of text.matchAll(global)) {
    if (found[0].length === 0) continue;
    ranges.push([found.index, found.index + found[0].length]);
  }
  return ranges;
}

/** Splits text at match bounds. */
export function splitTextForMatches(text: string, pattern: RegExp): MatchPart[] {
  return splitRunsForMatches([{ text }], pattern).map(({ text: part, match }) => ({
    text: part,
    match,
  }));
}

/**
 * Splits styled runs, such as syntax-highlighted code tokens, at match bounds. A match
 * may span runs; every piece of it carries the same match index. Each output run keeps
 * the fields of the run it came from.
 */
export function splitRunsForMatches<Run extends { text: string }>(
  runs: readonly Run[],
  pattern: RegExp,
): (Run & { match: number | null })[] {
  const ranges = matchRanges(runs.map((run) => run.text).join(""), pattern);
  const output: (Run & { match: number | null })[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const run of runs) {
    const end = offset + run.text.length;
    let cursor = offset;
    while (cursor < end) {
      while (rangeIndex < ranges.length && ranges[rangeIndex]![1] <= cursor) rangeIndex += 1;
      const range = ranges[rangeIndex];
      if (!range || range[0] >= end) {
        output.push({ ...run, text: run.text.slice(cursor - offset), match: null });
        cursor = end;
      } else if (range[0] > cursor) {
        output.push({
          ...run,
          text: run.text.slice(cursor - offset, range[0] - offset),
          match: null,
        });
        cursor = range[0];
      } else {
        const stop = Math.min(range[1], end);
        output.push({
          ...run,
          text: run.text.slice(cursor - offset, stop - offset),
          match: rangeIndex,
        });
        cursor = stop;
      }
    }
    offset = end;
  }
  return output;
}

/**
 * Lays match parts over styled runs of the same text, such as syntax tokens over a code
 * block whose matches were found elsewhere. Text past the parts keeps no match.
 */
export function overlayMatchParts<Run extends { text: string }>(
  runs: readonly Run[],
  parts: readonly MatchPart[],
): (Run & { match: number | null })[] {
  const output: (Run & { match: number | null })[] = [];
  let partIndex = 0;
  let partOffset = 0;
  for (const run of runs) {
    let cursor = 0;
    while (cursor < run.text.length) {
      const part = parts[partIndex];
      if (!part) {
        output.push({ ...run, text: run.text.slice(cursor), match: null });
        break;
      }
      const take = Math.min(run.text.length - cursor, part.text.length - partOffset);
      output.push({ ...run, text: run.text.slice(cursor, cursor + take), match: part.match });
      cursor += take;
      partOffset += take;
      if (partOffset === part.text.length) {
        partIndex += 1;
        partOffset = 0;
      }
    }
  }
  return output;
}
