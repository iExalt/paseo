import { describe, expect, test } from "vitest";
import { planForegroundVerification } from "./foreground-verification.js";

const SUSPECT = 25_000;

describe("planForegroundVerification", () => {
  test("a recently active socket keeps the two long windows", () => {
    expect(
      planForegroundVerification({
        silenceMs: SUSPECT,
        suspectSilenceMs: SUSPECT,
        lastRttMs: 40,
        userWaiting: false,
      }),
    ).toEqual({ windowMs: 5_000, silentWindows: 2 });
  });

  test("silence past a heartbeat cycle, or a waiting user, gets one window of three round trips", () => {
    const suspect = { suspectSilenceMs: SUSPECT, lastRttMs: 400 };
    expect(
      planForegroundVerification({ ...suspect, silenceMs: SUSPECT + 1, userWaiting: false }),
    ).toEqual({ windowMs: 1_200, silentWindows: 1 });
    expect(planForegroundVerification({ ...suspect, silenceMs: 0, userWaiting: true })).toEqual({
      windowMs: 1_200,
      silentWindows: 1,
    });
  });

  test("the short window stays between 0.75 s and 2 s, assuming a slow link before any round trip", () => {
    const base = { silenceMs: 0, suspectSilenceMs: SUSPECT, userWaiting: true };
    expect(planForegroundVerification({ ...base, lastRttMs: 5 }).windowMs).toBe(750);
    expect(planForegroundVerification({ ...base, lastRttMs: 5_000 }).windowMs).toBe(2_000);
    expect(planForegroundVerification({ ...base, lastRttMs: null }).windowMs).toBe(750);
  });
});
