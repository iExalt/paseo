import { describe, expect, it } from "vitest";
import {
  SELECTION_ACTION_BAR_GAP as GAP,
  SELECTION_ACTION_BAR_MARGIN as MARGIN,
  placeSelectionActionBar,
} from "./selection-action-bar";

const BASE = {
  endHandleHeight: 16,
  scrollTop: 1000,
  viewportWidth: 800,
  viewportHeight: 600,
  barWidth: 200,
  barHeight: 40,
};

describe("selection action bar placement", () => {
  it("sits above the start caret, centred on it", () => {
    const placement = placeSelectionActionBar({
      ...BASE,
      start: { x: 300, top: 1200, bottom: 1218 },
      end: { x: 500, top: 1300, bottom: 1318 },
    });
    expect(placement).toEqual({ left: 300 - 100, top: 200 - GAP - 40 });
  });

  it("drops below the end caret and its handle when the start is near the top", () => {
    const placement = placeSelectionActionBar({
      ...BASE,
      start: { x: 300, top: 1010, bottom: 1028 },
      end: { x: 500, top: 1100, bottom: 1118 },
    });
    expect(placement).toEqual({ left: 500 - 100, top: 118 + 16 + GAP });
  });

  it("pins to the top when the selection covers the viewport and hides when it is out of view", () => {
    const spanning = placeSelectionActionBar({
      ...BASE,
      start: { x: 300, top: 900, bottom: 918 },
      end: { x: 500, top: 1700, bottom: 1718 },
    });
    expect(spanning).toEqual({ left: 200, top: MARGIN });
    expect(
      placeSelectionActionBar({
        ...BASE,
        start: { x: 300, top: 100, bottom: 118 },
        end: { x: 500, top: 200, bottom: 218 },
      }),
    ).toBeNull();
    expect(
      placeSelectionActionBar({
        ...BASE,
        start: { x: 300, top: 1700, bottom: 1718 },
        end: { x: 500, top: 1800, bottom: 1818 },
      }),
    ).toBeNull();
  });

  it("keeps the bar inside the viewport's sides", () => {
    const caret = { top: 1300, bottom: 1318 };
    const left = placeSelectionActionBar({
      ...BASE,
      start: { x: 10, ...caret },
      end: { x: 10, ...caret },
    });
    expect(left?.left).toBe(MARGIN);
    const right = placeSelectionActionBar({
      ...BASE,
      start: { x: 790, ...caret },
      end: { x: 790, ...caret },
    });
    expect(right?.left).toBe(800 - MARGIN - 200);
  });
});
