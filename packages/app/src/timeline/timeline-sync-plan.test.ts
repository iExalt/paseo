import { describe, expect, test } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import {
  isTimelineCatchUpComplete,
  isTimelineResumeSnapshotAuthoritative,
  planTimelineGapFetch,
  planTimelineOlderFetch,
  planTimelinePromptJump,
  planTimelineResumeFetch,
  planTimelineTailFetch,
} from "./timeline-sync-plan";

describe("timeline sync planning", () => {
  test("agent synchronization checks a bounded tail page", () => {
    const plan = planTimelineTailFetch();

    expect(plan).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
    });
  });

  test("a restored canonical range catches up after its exact end", () => {
    expect(planTimelineResumeFetch({ epoch: "epoch-1", endSeq: 49 })).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 49 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
    });
  });

  test("older history loads one bounded page before the start cursor", () => {
    const plan = planTimelineOlderFetch({ epoch: "epoch-1", seq: 25 });

    expect(plan).toEqual({
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 25 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
    });
  });

  test("an unloaded prompt jump merges a window with half a page newer than the target", () => {
    expect(planTimelinePromptJump({ epoch: "epoch-1", seq: 42 })).toEqual({
      direction: "before",
      cursor: {
        epoch: "epoch-1",
        seq: 42 + Math.floor(TIMELINE_FETCH_PAGE_SIZE / 2) + 1,
      },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
      mergeWindow: true,
    });
  });

  test("a reader in a jump window loads the hole after the window, and only there", () => {
    const cursor = {
      epoch: "epoch-1",
      startSeq: 101,
      endSeq: 140,
      retainedRanges: [{ startSeq: 4, endSeq: 43 }],
    };

    expect(planTimelineGapFetch({ cursor, readingSeq: 24 })).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 43 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      mergeWindow: true,
    });
    // The tail is the newest range: nothing follows it.
    expect(planTimelineGapFetch({ cursor, readingSeq: 120 })).toBeNull();
    // Adjacent ranges leave no hole.
    expect(
      planTimelineGapFetch({
        cursor: { ...cursor, retainedRanges: [{ startSeq: 4, endSeq: 100 }] },
        readingSeq: 24,
      }),
    ).toBeNull();
    // A small hole is loaded without overlapping the tail.
    expect(
      planTimelineGapFetch({
        cursor: { ...cursor, retainedRanges: [{ startSeq: 4, endSeq: 90 }] },
        readingSeq: 24,
      })?.limit,
    ).toBe(10);
  });

  test("catch-up finishes when the daemon reports no newer rows", () => {
    expect(isTimelineCatchUpComplete({ direction: "after", hasNewer: false, error: null })).toBe(
      true,
    );
  });

  test("only tail and completed forward pages carry an authoritative resume snapshot", () => {
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "tail",
        hasNewer: false,
        error: null,
      }),
    ).toBe(true);
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "after",
        hasNewer: false,
        error: null,
      }),
    ).toBe(true);
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "before",
        hasNewer: false,
        error: null,
      }),
    ).toBe(false);
  });
});
