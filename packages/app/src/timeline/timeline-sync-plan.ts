import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export interface TimelineSyncCursor {
  epoch: string;
  seq: number;
}

export interface ProjectedTimelineTailFetchPlan {
  direction: "tail";
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineAfterFetchPlan {
  direction: "after";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineBeforeFetchPlan {
  direction: "before";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export type ProjectedTimelineFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan
  | ProjectedTimelineBeforeFetchPlan;

export type ProjectedTimelineForwardFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan;

export function planTimelineCatchUpAfter(cursor: TimelineSyncCursor) {
  return {
    direction: "after",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineTailFetch() {
  return {
    direction: "tail",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineResumeFetch(
  range: { epoch: string; endSeq: number } | null | undefined,
): ProjectedTimelineForwardFetchPlan {
  return range
    ? planTimelineCatchUpAfter({ epoch: range.epoch, seq: range.endSeq })
    : planTimelineTailFetch();
}

export function planTimelineOlderFetch(cursor: TimelineSyncCursor) {
  return {
    direction: "before",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelinePromptJump(target: TimelineSyncCursor) {
  const newerRows = Math.floor(TIMELINE_FETCH_PAGE_SIZE / 2);
  return {
    direction: "before",
    cursor: { epoch: target.epoch, seq: target.seq + newerRows + 1 },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
    mergeWindow: true,
  } as const;
}

export interface TimelineLoadedCoverage {
  epoch: string;
  startSeq: number;
  endSeq: number;
  retainedRanges?: ReadonlyArray<{ startSeq: number; endSeq: number }>;
}

// A prompt jump merges a window that can sit apart from the loaded tail. Fill the hole
// forward from the end of the range being read, so scrolling newer never skips rows.
// The limit stays within the hole so a page does not re-deliver rows of the next range.
export function planTimelineGapFetch(input: {
  cursor: TimelineLoadedCoverage;
  readingSeq: number;
}) {
  const { cursor, readingSeq } = input;
  const ranges = [
    { startSeq: cursor.startSeq, endSeq: cursor.endSeq },
    ...(cursor.retainedRanges ?? []),
  ].sort((left, right) => left.startSeq - right.startSeq);
  const index = ranges.findIndex(
    (range) => range.startSeq <= readingSeq && readingSeq <= range.endSeq,
  );
  const range = ranges[index];
  const next = ranges[index + 1];
  if (!range || !next) return null;
  const missingSeqs = next.startSeq - range.endSeq - 1;
  if (missingSeqs <= 0) return null;
  return {
    direction: "after",
    cursor: { epoch: cursor.epoch, seq: range.endSeq },
    limit: Math.min(TIMELINE_FETCH_PAGE_SIZE, missingSeqs),
    projection: "projected",
    mergeWindow: true,
  } as const;
}

// Older history extends the earliest loaded range. After a prompt jump that is the jump
// window, not the tail: paging before the tail would pour rows into the hole instead.
export function getEarliestLoadedSeq(cursor: TimelineLoadedCoverage): number {
  return Math.min(cursor.startSeq, ...(cursor.retainedRanges ?? []).map((range) => range.startSeq));
}

export function isTimelineCatchUpComplete(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error) {
    return false;
  }

  return input.direction !== "after" || !input.hasNewer;
}

export function isTimelineResumeSnapshotAuthoritative(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error || input.direction === "before") return false;
  return input.direction === "tail" || !input.hasNewer;
}
