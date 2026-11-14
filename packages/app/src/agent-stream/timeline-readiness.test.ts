import { describe, expect, it } from "vitest";
import {
  readClosedTurns,
  recordTurnActivity,
  resolveTimelineReadiness,
} from "./timeline-readiness";

describe("resolveTimelineReadiness", () => {
  it("ranks a sync failure over a catch-up over a running turn", () => {
    expect(resolveTimelineReadiness({ sync: "sync_error", isTurnActive: true })).toBe("error");
    expect(resolveTimelineReadiness({ sync: "catching_up", isTurnActive: true })).toBe("loading");
    expect(resolveTimelineReadiness({ sync: "reconnecting", isTurnActive: false })).toBe("loading");
    expect(resolveTimelineReadiness({ sync: "idle", isTurnActive: true })).toBe("running");
    expect(resolveTimelineReadiness({ sync: "idle", isTurnActive: false })).toBe("settled");
  });
});

describe("recordTurnActivity", () => {
  it("counts only the end of a turn", () => {
    const key = "srv:agent-count";
    recordTurnActivity(key, false, true);
    recordTurnActivity(key, true, true);
    expect(readClosedTurns(key)).toBe(0);
    recordTurnActivity(key, true, false);
    recordTurnActivity(key, false, false);
    expect(readClosedTurns(key)).toBe(1);
  });
});
