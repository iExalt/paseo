import type { TerminalFindMatch } from "./terminal-buffer-search";
import type { TerminalBufferSearchResult } from "./headless-terminal-state";

export interface TerminalFindState {
  matches: TerminalFindMatch[];
  limited: boolean;
  /** Index of the selected match, or -1. */
  current: number;
}

export interface TerminalFindSource {
  search(query: string): TerminalBufferSearchResult;
  /** Changes with every write, so a quiet terminal answers Next without a rescan. */
  revision(): number;
  /** Changes when rows are renumbered (resize, reset), so old positions mean nothing. */
  coordinateEpoch(): number;
}

function compare(a: TerminalFindMatch, b: TerminalFindMatch): number {
  return a.startRow - b.startRow || a.startCol - b.startCol;
}

/**
 * Terminal find's selection over a buffer that keeps changing. Rows are absolute, so
 * trimmed scrollback does not renumber the rows that stay: after new output, Next and
 * Previous step from where the selected match is, not from its old index.
 */
export function createTerminalFindController(source: TerminalFindSource) {
  let query = "";
  let cache: { query: string; revision: number; result: TerminalBufferSearchResult } | null = null;
  let selected: { match: TerminalFindMatch; epoch: number } | null = null;
  let state: TerminalFindState = { matches: [], limited: false, current: -1 };

  function scan(): TerminalBufferSearchResult {
    const revision = source.revision();
    if (cache?.query !== query || cache.revision !== revision) {
      cache = { query, revision, result: source.search(query) };
    }
    return cache.result;
  }

  function select(result: TerminalBufferSearchResult, current: number): TerminalFindState {
    const match = result.matches[current];
    selected = match ? { match, epoch: source.coordinateEpoch() } : null;
    state = { matches: result.matches, limited: result.limited, current: match ? current : -1 };
    return state;
  }

  return {
    /** A new query selects the first match at or below `fromRow`, else the first. */
    search(nextQuery: string, fromRow: number): TerminalFindState {
      query = nextQuery;
      const result = scan();
      const below = result.matches.findIndex((match) => match.startRow >= fromRow);
      return select(result, below >= 0 ? below : 0);
    },
    step(direction: 1 | -1): TerminalFindState {
      const result = scan();
      const count = result.matches.length;
      if (count === 0) return select(result, -1);
      const anchor = selected?.epoch === source.coordinateEpoch() ? selected.match : null;
      if (!anchor) return select(result, direction === 1 ? 0 : count - 1);
      // Where the selected match sits now; trimmed away means the first one after it.
      const at = result.matches.findIndex((match) => compare(match, anchor) >= 0);
      const exact = at >= 0 && compare(result.matches[at]!, anchor) === 0;
      let next: number;
      // Nothing at or after the anchor (output cleared it): Next wraps to the first.
      if (at < 0) next = direction === 1 ? 0 : count - 1;
      else if (direction === 1) next = exact ? at + 1 : at;
      else next = at - 1;
      return select(result, ((next % count) + count) % count);
    },
    clear(): void {
      query = "";
      cache = null;
      selected = null;
      state = { matches: [], limited: false, current: -1 };
    },
    state(): TerminalFindState {
      return state;
    },
  };
}
