import { describe, expect, test } from "vitest";
import { lateFireSlackMs, planForegroundVerification } from "./foreground-verification.js";

const LINK = { heartbeatIntervalMs: 10_000, suspectSilenceMs: 25_000 };
const LONG = { windowMs: 5_000, silentWindows: 2 };

describe("planForegroundVerification", () => {
  test("a resume within a heartbeat cycle keeps the two long windows", () => {
    expect(
      planForegroundVerification({ ...LINK, silenceMs: 25_000, lastRttMs: 40, userWaiting: false }),
    ).toEqual(LONG);
  });

  test("a waiting user on a socket that spoke within a heartbeat interval keeps the long windows", () => {
    expect(
      planForegroundVerification({ ...LINK, silenceMs: 3_000, lastRttMs: 900, userWaiting: true }),
    ).toEqual(LONG);
  });

  test("silence past a heartbeat cycle, or past an interval with a user waiting, gets one window of three round trips", () => {
    const base = { ...LINK, lastRttMs: 400 };
    const short = { windowMs: 1_200, silentWindows: 1 };
    expect(planForegroundVerification({ ...base, silenceMs: 25_001, userWaiting: false })).toEqual(
      short,
    );
    expect(planForegroundVerification({ ...base, silenceMs: 10_001, userWaiting: true })).toEqual(
      short,
    );
  });

  test("the short window stays between 0.75 s and 2 s, assuming a slow link before any round trip", () => {
    const base = { ...LINK, silenceMs: 60_000, userWaiting: true };
    expect(planForegroundVerification({ ...base, lastRttMs: 5 }).windowMs).toBe(750);
    expect(planForegroundVerification({ ...base, lastRttMs: 5_000 }).windowMs).toBe(2_000);
    expect(planForegroundVerification({ ...base, lastRttMs: null }).windowMs).toBe(750);
  });
});

describe("lateFireSlackMs", () => {
  test("short windows tolerate half their length, long windows keep 2 s", () => {
    expect(lateFireSlackMs(750)).toBe(375);
    expect(lateFireSlackMs(300)).toBe(250);
    expect(lateFireSlackMs(5_000)).toBe(2_000);
  });
});
