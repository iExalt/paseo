import { describe, expect, it } from "vitest";
import type { ViewToken } from "react-native";
import type { StreamItem } from "@/types/stream";
import type { BottomAnchorMode } from "./bottom-anchor-controller";
import { createNativeReadingPosition } from "./native-reading-position";

const row = (id: string, messageId = id) =>
  ({ kind: "assistant_message", id, messageId, text: "" }) as unknown as StreamItem;

/** The inverted list, its measurements, upstream's bottom anchor and timers, in memory. */
function setup(ids = ["r0", "r1", "r2", "r3"]) {
  const calls: string[] = [];
  const state = {
    rows: ids.map((id) => row(id)),
    offsetY: 0,
    viewportHeight: 1000,
    contentHeight: 5000,
    mode: "sticky-bottom" as BottomAnchorMode,
    budget: 0,
    now: 0,
  };
  const timeouts = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const frames: Array<() => void> = [];
  const reported: Array<string | null> = [];
  const position = createNativeReadingPosition({
    list: {
      scrollToIndex: ({ index, animated }) => calls.push(`index ${index} ${animated}`),
      scrollToOffset: ({ offset, animated }) => calls.push(`offset ${offset} ${animated}`),
      armScrollBudget: () => {
        state.budget = 3;
      },
      offsetY: () => state.offsetY,
      viewportHeight: () => state.viewportHeight,
      contentHeight: () => state.contentHeight,
      rows: () => state.rows,
      newestRowId: () => state.rows[0]?.id,
    },
    anchor: {
      mode: () => state.mode,
      detachByUser: () => {
        calls.push("detach");
        state.mode = "detached";
      },
    },
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = nextTimer++;
        timeouts.set(id, { at: state.now + delayMs, callback });
        return id;
      },
      clearTimeout: (timer) => void timeouts.delete(timer as number),
      requestFrame: (callback) => void frames.push(callback),
    },
    onReadingPositionChange: (rowId) => reported.push(rowId),
    onNearBottomChange: (nearBottom) => calls.push(`nearBottom ${nearBottom}`),
  });
  const advance = (ms: number) => {
    state.now += ms;
    for (const [id, timer] of timeouts) {
      if (timer.at > state.now) continue;
      timeouts.delete(id);
      timer.callback();
    }
  };
  const runFrame = () => frames.shift()?.();
  /** FlatList reports these rows viewable; the highest index is the top of the inverted list. */
  const view = (...viewIds: string[]) =>
    position.viewableItemsChanged({
      viewableItems: viewIds.map((id) => ({
        item: state.rows.find((candidate) => candidate.id === id)!,
        key: id,
        index: state.rows.findIndex((candidate) => candidate.id === id),
        isViewable: true,
      })) as ViewToken<StreamItem>[],
    });
  /** One settle as the host runs it: four frames, then as long as the module asks. */
  const settle = () => {
    position.settleStart();
    let remaining = 4;
    for (let frame = 0; frame < 100; frame += 1) {
      const awaits = position.settleFrame();
      if (remaining <= 0 && !awaits) break;
      remaining -= 1;
    }
    position.settled();
  };
  return { position, state, calls, reported, advance, runFrame, view, settle };
}

describe("native reading position", () => {
  it("jumps to a message detached and programmatic, and keeps a long animated jump programmatic", () => {
    const { position, state, calls, advance } = setup();
    position.jumpToMessage("r2");
    expect(calls).toEqual(["detach", "nearBottom false", "index 2 true"]);
    expect(state.budget).toBe(3);

    // Each scroll event of the jump extends the quiet window, so a 500 ms animation stays programmatic.
    for (let elapsed = 0; elapsed < 500; elapsed += 150) {
      advance(150);
      const step = position.scrollStart({
        previousWidth: 800,
        width: 800,
        userScrollActive: false,
      });
      expect(step.programmatic).toBe(true);
    }
    advance(200);
    expect(
      position.scrollStart({ previousWidth: 800, width: 800, userScrollActive: false })
        .programmatic,
    ).toBe(false);
  });

  it("jumps to live rows at offset zero without spending the scroll budget", () => {
    const { position, state, calls } = setup();
    position.jumpToItem("live-row");
    expect(calls).toEqual(["detach", "nearBottom false", "offset 0 false"]);
    expect(state.budget).toBe(0);
  });

  it("retries a failed jump by row id, after rows merged ahead of it", () => {
    const { position, state, calls, runFrame } = setup();
    position.jumpToItem("r2");
    calls.length = 0;
    state.budget = 0;
    position.scrollToIndexFailed({ averageItemLength: 100 });
    expect(calls).toEqual(["offset 200 false"]);
    expect(state.budget).toBe(3);
    // A new row lands at the bottom of the inverted list before the retry frame.
    state.rows = [row("new"), ...state.rows];
    runFrame();
    expect(calls).toEqual(["offset 200 false", "index 3 false"]);
  });

  it("restores the reading row after a width change once the rewrap settles, only while detached", () => {
    const { position, calls, view, settle } = setup();
    position.hold();
    view("r1", "r2");
    calls.length = 0;
    // Android reports the new width in a scroll event before onLayout.
    const step = position.scrollStart({ previousWidth: 800, width: 1200, userScrollActive: false });
    expect(step.startSettle).toBe(true);
    // Rows from the rewrapped layout don't move the frozen reader.
    view("r0", "r1");
    settle();
    expect(calls).toEqual(["detach", "nearBottom false", "index 2 false"]);

    // Re-stuck to the bottom during the settle: the restore is dropped.
    const sticky = setup();
    sticky.position.hold();
    sticky.view("r1", "r2");
    sticky.position.viewportChanged(800, 1200);
    sticky.state.mode = "sticky-bottom";
    sticky.calls.length = 0;
    sticky.settle();
    expect(sticky.calls).toEqual([]);
  });

  it("keeps the settle running until content height holds for three frames", () => {
    const { position, state, view } = setup();
    position.hold();
    view("r1");
    position.viewportChanged(800, 1200);
    position.settleStart();
    const heights = [5100, 5200, 5300, 5300, 5300, 5300];
    const answers = heights.map((height) => {
      state.contentHeight = height;
      return position.settleFrame();
    });
    expect(answers).toEqual([true, true, true, true, true, false]);
  });

  it("lets a drag or a jump to bottom cancel a pending restore, but not a hold", () => {
    for (const interrupt of ["drag", "bottom", "hold"] as const) {
      const { position, calls, view, settle } = setup();
      position.hold();
      view("r1", "r2");
      position.viewportChanged(800, 1200);
      if (interrupt === "drag") position.beginDrag();
      if (interrupt === "bottom") position.cancel();
      if (interrupt === "hold") position.hold();
      calls.length = 0;
      settle();
      expect([interrupt, calls.includes("index 2 false")]).toEqual([
        interrupt,
        interrupt === "hold",
      ]);
    }
  });

  it("does not freeze during a user drag or while already restoring", () => {
    const { position, view } = setup();
    position.hold();
    view("r1");
    expect(
      position.scrollStart({ previousWidth: 800, width: 1200, userScrollActive: true }).startSettle,
    ).toBe(false);
    position.viewportChanged(800, 1200);
    expect(
      position.scrollStart({ previousWidth: 1200, width: 900, userScrollActive: false })
        .startSettle,
    ).toBe(false);
  });

  it("reads the reading row at scrollEnd from the offset the host recorded after scrollStart", () => {
    const { position, state, reported, view } = setup();
    view("r1", "r2");
    position.rowLayout("r1", { y: 0, height: 900 });
    position.rowLayout("r2", { y: 900, height: 900 });
    reported.length = 0;
    position.scrollStart({ previousWidth: 800, width: 800, userScrollActive: false });
    // The reading line sits 8 px under the viewport top: offset + 1000 - 8.
    state.offsetY = 0;
    position.scrollEnd();
    state.offsetY = 200;
    position.scrollEnd();
    expect(reported).toEqual(["r2", "r2"]);
    state.offsetY = -150;
    position.scrollEnd();
    expect(reported.at(-1)).toBe("r1");
  });

  it("moves the tick when a viewable row resizes, without feeding the rotation restore", () => {
    const { position, reported, calls, view, settle } = setup();
    position.hold();
    view("r1");
    position.rowLayout("r1", { y: 0, height: 400 });
    position.rowLayout("r2", { y: 400, height: 400 });
    view("r1", "r2");
    // A layout pass grows r1, pushing r2 above the reading line, ahead of the freeze.
    reported.length = 0;
    position.rowLayout("r2", { y: 2000, height: 400 });
    expect(reported).toEqual(["r1"]);
    position.viewportChanged(800, 1200);
    calls.length = 0;
    settle();
    expect(calls).toEqual(["detach", "nearBottom false", "index 2 false"]);
  });

  it("forgets the viewable rows and the pending restore for a different agent", () => {
    const { position, reported, calls, view, settle } = setup();
    position.hold();
    view("r1");
    position.viewportChanged(800, 1200);
    position.reset();
    calls.length = 0;
    reported.length = 0;
    settle();
    position.scrollEnd();
    expect(calls).toEqual([]);
    expect(reported).toEqual([]);
  });
});
