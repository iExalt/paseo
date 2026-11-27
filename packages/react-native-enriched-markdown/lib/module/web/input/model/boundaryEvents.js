"use strict";

// One end of a formatting range, for sweeps that walk ranges in document
// order.

// Ascending by position, and at one position closings come before openings so
// a range ending where another begins never interleaves. `tieBreak` orders
// same-direction events at one position, for callers that need it.
export function compareBoundaryEvents(a, b, tieBreak) {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  if (a.isOpening !== b.isOpening) {
    return a.isOpening ? 1 : -1;
  }
  return tieBreak === undefined ? 0 : tieBreak(a, b);
}
//# sourceMappingURL=boundaryEvents.js.map
