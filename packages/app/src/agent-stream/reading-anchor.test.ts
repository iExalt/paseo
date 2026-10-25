import { describe, expect, it } from "vitest";
// RN's own helper is Flow source that vitest cannot parse. react-native-web vendors a plain
// JS copy with the same threshold invariant and visibility rule. It ships no types.
// @ts-expect-error TS7016
import ViewabilityHelper from "react-native-web/dist/vendor/react-native/ViewabilityHelper";
import {
  createNativeReadingAnchor,
  createReadingAnchor,
  createNativeRowGeometry,
  createReadingSeqDedupe,
  getReadingRowIdFromGeometry,
  getTopmostViewableRowId,
  MAX_SCROLL_TO_INDEX_RETRIES,
  planScrollToIndexRetry,
  READING_VIEWABILITY_CONFIG,
} from "./reading-anchor";

describe("reading anchor", () => {
  const rows = [
    { id: "above", top: 0, height: 500 },
    { id: "reading", top: 500, height: 500 },
    { id: "below", top: 1000, height: 500 },
  ];

  it("preserves wheel movement during an asynchronous prepend", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(2440);
    expect(
      anchor.reconcile(
        2280,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(2280);
  });

  it("ignores growth below the reader and compensates growth above", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(anchor.reconcile(600, [rows[0]!, rows[1]!, { ...rows[2]!, height: 2000 }])).toBe(600);
    expect(
      anchor.reconcile(600, [
        { ...rows[0]!, height: 1000 },
        { ...rows[1]!, top: 1000 },
        { ...rows[2]!, top: 1500 },
      ]),
    ).toBe(1100);
  });

  it("leaves expansion of the row being read in place", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(
      anchor.reconcile(600, [rows[0]!, { ...rows[1]!, height: 1000 }, { ...rows[2]!, top: 1500 }]),
    ).toBe(600);
  });

  it("keeps the existing reader through prepend measurements until the user scrolls", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(0, [{ id: "reading", top: 48, height: 100 }]);
    const prepended = [
      { id: "new", top: 2000, height: 57 },
      { id: "reading", top: 2057, height: 100 },
    ];
    expect(anchor.reconcile(0, prepended)).toBe(2009);
    expect(anchor.getRowId()).toBe("reading");
    const measured = [
      { id: "new", top: 2000, height: 100 },
      { id: "reading", top: 2100, height: 100 },
    ];
    expect(anchor.reconcile(2009, measured)).toBe(2052);
    expect(anchor.getRowId()).toBe("reading");
    expect(anchor.reconcile(2000, measured, true)).toBe(2000);
    expect(anchor.getRowId()).toBe("new");
  });

  it("retains the reader while the virtualizer initializes its mounted range", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.reconcile(600, [rows[2]!]);
    expect(anchor.getRowId()).toBe("reading");
    expect(
      anchor.reconcile(
        600,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
      ),
    ).toBe(2600);
  });

  it("projects a prepend range without consuming the correction before layout commits", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(anchor.project(440, { id: "reading", top: 2500 })).toBe(2440);
    expect(anchor.project(440, { id: "reading", top: 2500 })).toBe(2440);
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
        true,
      ),
    ).toBe(2440);
    expect(anchor.getRowId()).toBe("above");
  });

  it("repicks from user movement before applying a simultaneous layout correction", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.scroll(440);
    expect(anchor.getRowId()).toBe("above");
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
      ),
    ).toBe(2440);
    expect(anchor.getRowId()).toBe("above");
  });

  it("releases the old reading position for explicit navigation", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.reset();
    expect(anchor.getRowId()).toBeNull();
    expect(
      anchor.reconcile(
        0,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(0);
  });
});

describe("topmost viewable row", () => {
  // The native list is inverted: index 0 is the newest row, so the highest index is the top.
  it("reports the highest viewable index as the row being read", () => {
    expect(
      getTopmostViewableRowId(
        [
          { id: "newer", index: 1, isViewable: true },
          { id: "older", index: 3, isViewable: true },
          { id: "middle", index: 2, isViewable: true },
        ],
        "newest",
      ),
    ).toBe("older");
  });

  it("ignores rows that are not viewable or have no index", () => {
    expect(
      getTopmostViewableRowId(
        [
          { id: "gone", index: 9, isViewable: false },
          { id: "header", index: null, isViewable: true },
          { id: "reading", index: 2, isViewable: true },
        ],
        "newest",
      ),
    ).toBe("reading");
  });

  it("falls back to the newest row, or null, when nothing is viewable", () => {
    expect(getTopmostViewableRowId([], "newest")).toBe("newest");
    expect(getTopmostViewableRowId([], undefined)).toBeNull();
  });
});

describe("native reading row from geometry", () => {
  // Inverted list: a row's visual bottom is its y, and the viewport top is offsetY + height.
  const viewportTop = 1800;
  const geometryWith = (sliver: number) => {
    const geometry = createNativeRowGeometry();
    geometry.record("prompt", { y: 1000, height: viewportTop - sliver - 1000 });
    geometry.record("previous-turn", { y: viewportTop - sliver, height: 500 });
    return geometry;
  };
  const rows = [
    { id: "prompt", index: 2, isViewable: true },
    { id: "previous-turn", index: 3, isViewable: true },
  ];
  const read = (sliver: number) =>
    getReadingRowIdFromGeometry({
      rows,
      geometry: geometryWith(sliver),
      offsetY: 1000,
      viewportHeight: 800,
      newestRowId: "newest",
    });

  it.each([1, 3, 5, 7, 8])("ignores a %i px sliver of the previous turn", (sliver) => {
    expect(read(sliver)).toBe("prompt");
  });

  it("hands over once the previous turn clears the 8 px reading line", () => {
    expect(read(9)).toBe("previous-turn");
  });

  it("falls back to the topmost viewable row without every viewable layout", () => {
    const geometry = createNativeRowGeometry();
    geometry.record("prompt", { y: 1000, height: 792 });
    expect(
      getReadingRowIdFromGeometry({
        rows,
        geometry,
        offsetY: 1000,
        viewportHeight: 800,
        newestRowId: "newest",
      }),
    ).toBe("previous-turn");
    expect(
      getReadingRowIdFromGeometry({
        rows,
        geometry: geometryWith(3),
        offsetY: 1000,
        viewportHeight: 0,
        newestRowId: "newest",
      }),
    ).toBe("previous-turn");
  });

  it("reports the newest row when no viewable row clears the line", () => {
    const geometry = createNativeRowGeometry();
    geometry.record("previous-turn", { y: 1795, height: 500 });
    expect(
      getReadingRowIdFromGeometry({
        rows: [rows[1]],
        geometry,
        offsetY: 1000,
        viewportHeight: 800,
        newestRowId: "newest",
      }),
    ).toBe("newest");
  });

  it("reports a recorded frame change only when it moves", () => {
    const geometry = createNativeRowGeometry();
    expect(geometry.record("a", { y: 0, height: 10 })).toBe(true);
    expect(geometry.record("a", { y: 0, height: 10 })).toBe(false);
    expect(geometry.record("a", { y: 0, height: 12 })).toBe(true);
    geometry.forget("a");
    expect(geometry.get("a")).toBeUndefined();
  });
});

describe("reading seq dedupe", () => {
  const forwarded = (reports: { rowId: string; seq: number | null }[]) => {
    const dedupe = createReadingSeqDedupe();
    return reports.filter((report) => dedupe.shouldForward(report.seq)).map((r) => r.seq);
  };

  it("forwards a row again once its seq resolves, and skips true repeats", () => {
    expect(
      forwarded([
        { rowId: "row", seq: null },
        { rowId: "row", seq: null },
        { rowId: "row", seq: 12 },
        { rowId: "row", seq: 12 },
      ]),
    ).toEqual([null, 12]);
  });

  it("forwards the same seq again after a reset", () => {
    const dedupe = createReadingSeqDedupe();
    expect(dedupe.shouldForward(12)).toBe(true);
    dedupe.reset();
    expect(dedupe.shouldForward(12)).toBe(true);
  });
});

describe("reading viewability config", () => {
  // The inverted list lays out index 0 at offset 0, the newest row at the bottom.
  const lengths = [100, 300, 300, 300, 300];
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, n) => sum + n, 0));
  const props = { data: lengths, getItemCount: () => lengths.length };
  const getFrameMetrics = (index: number) => ({
    offset: offsets[index]!,
    length: lengths[index]!,
  });
  const viewable = (scrollOffset: number, viewportHeight: number) =>
    new ViewabilityHelper(READING_VIEWABILITY_CONFIG).computeViewableItems(
      props,
      scrollOffset,
      viewportHeight,
      getFrameMetrics,
    );

  it("counts a partly visible row as viewable and excludes rows fully off screen", () => {
    // Viewport 150..650: rows 0 (ends at 100) is off screen, row 1 spans 100..400,
    // row 2 spans 400..700, row 3 starts at 700.
    expect(viewable(150, 500)).toEqual([1, 2]);
    // A one pixel sliver of row 3 at the top edge still counts.
    expect(viewable(699, 500)).toEqual([2, 3, 4]);
  });

  it("feeds the topmost viewable row to the reading position", () => {
    const rows = viewable(150, 500).map((index: number) => ({
      id: `row-${index}`,
      index,
      isViewable: true,
    }));
    expect(getTopmostViewableRowId(rows, "newest")).toBe("row-2");
  });
});

describe("native reading anchor", () => {
  const rotate = { previousWidth: 1200, width: 800 };

  it("restores the pre-reflow row once, ignoring reports from the drifting layout", () => {
    const anchor = createNativeReadingAnchor();
    anchor.noteViewable("prompt-12");
    expect(anchor.beginViewportChange({ ...rotate, detached: true })).toBe(true);
    anchor.noteViewable("prompt-61");
    // A second size change before settling keeps the original reader.
    expect(anchor.beginViewportChange({ previousWidth: 800, width: 820, detached: true })).toBe(
      true,
    );
    expect(anchor.isRestorePending()).toBe(true);
    expect(anchor.takeRestoreRowId()).toBe("prompt-12");
    expect(anchor.takeRestoreRowId()).toBeNull();
    expect(anchor.isRestorePending()).toBe(false);
    // Reports after the restore track the reader again.
    anchor.noteViewable("prompt-13");
    anchor.beginViewportChange({ previousWidth: 800, width: 1200, detached: true });
    expect(anchor.takeRestoreRowId()).toBe("prompt-13");
  });

  it("leaves sticky readers, first layout and unchanged widths to the list", () => {
    const anchor = createNativeReadingAnchor();
    anchor.noteViewable("prompt-12");
    for (const change of [
      { ...rotate, detached: false },
      { previousWidth: 0, width: 800, detached: true },
      { previousWidth: 1200, width: 1200.4, detached: true },
    ]) {
      expect(anchor.beginViewportChange(change)).toBe(false);
    }
    expect(anchor.takeRestoreRowId()).toBeNull();
    expect(createNativeReadingAnchor().beginViewportChange({ ...rotate, detached: true })).toBe(
      false,
    );
  });

  it("drops the restore when the user takes over", () => {
    const anchor = createNativeReadingAnchor();
    anchor.noteViewable("prompt-12");
    anchor.beginViewportChange({ ...rotate, detached: true });
    anchor.cancel();
    expect(anchor.takeRestoreRowId()).toBeNull();
  });
});

describe("scrollToIndex retry", () => {
  // The inverted list puts the newest row at index 0.
  const prompts = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ id: `prompt-${to - i}` }));
  const retry = (rows: readonly { id: string }[], targetRowId: string | null, attempts = 0) =>
    planScrollToIndexRetry({ rows, targetRowId, averageItemLength: 100, attempts });

  it("aims at the target's index after newer rows land at lower indices", () => {
    // Tail 51-70 and window 1-32: a jump to prompt 12 fails at index 40.
    expect(retry([...prompts(51, 70), ...prompts(1, 32)], "prompt-12")?.index).toBe(40);
    // Before the retry runs, 33-50 merge between them.
    expect(retry(prompts(1, 70), "prompt-12")).toEqual({ index: 58, estimatedOffset: 5800 });
  });

  it("stops when the target is gone or the attempts run out", () => {
    const rows = prompts(1, 70);
    expect(retry(rows, "prompt-99")).toBeNull();
    expect(retry(rows, null)).toBeNull();
    expect(retry(rows, "prompt-12", MAX_SCROLL_TO_INDEX_RETRIES)).toBeNull();
  });
});
