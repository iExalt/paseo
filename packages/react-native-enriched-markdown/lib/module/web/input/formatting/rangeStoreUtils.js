"use strict";

import { firstIndexReachingTarget } from "../utils.js";
// Equal starts insert after existing entries: the first start past
// `location`, which for integer offsets is the first one reaching the next.
export function sortedInsertionIndex(ranges, location) {
  return firstIndexReachingTarget(location + 1, ranges.length, index => ranges[index].start);
}
//# sourceMappingURL=rangeStoreUtils.js.map
