import { describe, expect, it, vi } from "vitest";
import { createAccessibilitySampler } from "./accessibility-sampler";
import { diffAccessibilitySummary } from "./accessibility-summary";
import type { DiffCell, DiffLineRow, DiffStatusRow } from "./types";

function cell(type: DiffCell["type"], content: string, lineNumber: number): DiffCell {
  return {
    type,
    content,
    lineNumber,
    tokens: [],
    fragments: [],
    reviewTarget: null,
    sourceIdentity: {
      hunkIndex: 0,
      lineIndex: lineNumber,
      side: type === "remove" ? "old" : "new",
    },
  };
}
function row(index: number, cells: DiffLineRow["cells"], path = "a.ts"): DiffLineRow {
  return {
    kind: "line",
    index,
    fileIndex: 0,
    path,
    top: index * 20,
    height: 20,
    cells,
    reviewHeight: 0,
  };
}
describe("diff accessibility summary", () => {
  it("describes only visible rows and preserves split changes without repeating context", () => {
    const rows = [
      row(0, [cell("context", "before", 1)]),
      row(1, [cell("remove", "old", 2), cell("add", "new", 2)]),
      row(2, [cell("context", "same", 3), cell("context", "same", 3)]),
    ];
    expect(diffAccessibilitySummary({ rows }, 20, 40)).toBe(
      "a.ts\nRemoved 2 old\nAdded 2 new\nContext 3 same",
    );
  });
  it("includes file status and bounds large visible content with an omission cue", () => {
    const status: DiffStatusRow = {
      kind: "status",
      index: 0,
      fileIndex: 0,
      path: "binary",
      top: 0,
      height: 20,
      label: "Binary file",
    };
    expect(diffAccessibilitySummary({ rows: [status] }, 0, 20)).toBe("binary\nBinary file");
    const rows = Array.from({ length: 300 }, (_, index) =>
      row(index, [cell("add", "x".repeat(1000), index)]),
    );
    const summary = diffAccessibilitySummary({ rows }, 0, 6000);
    expect(summary.length).toBeLessThanOrEqual(12_000);
    expect(summary).toContain("More lines omitted");
  });
});

it("publishes the last position after a rapid programmatic scroll and cancels on disposal", () => {
  vi.useFakeTimers();
  try {
    let top = 20;
    const publish = vi.fn();
    const sampler = createAccessibilitySampler(() => top, publish);
    sampler.sample(top);
    top = 500;
    vi.advanceTimersByTime(200);
    expect(publish.mock.calls).toEqual([[20], [500]]);
    sampler.sample(600);
    sampler.dispose();
    vi.advanceTimersByTime(200);
    expect(publish).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
