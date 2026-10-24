import { describe, expect, it } from "vitest";
// RN's own helper is Flow source that vitest cannot parse. react-native-web vendors a plain
// JS copy with the same threshold invariant and visibility rule. It ships no types.
// @ts-expect-error TS7016
import ViewabilityHelper from "react-native-web/dist/vendor/react-native/ViewabilityHelper";
import {
  createReadingAnchor,
  getTopmostViewableRowId,
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
