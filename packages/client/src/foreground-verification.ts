// How hard to check the socket when the app returns to the foreground.
//
// A socket that silently died while the app was suspended stays OPEN and accepts sends, so only
// inbound frames prove it is alive. The default check waits two windows before tearing it down,
// which protects slow but healthy links. When the socket is already suspect, or a user is waiting
// on the screen (a notification tap), one short window decides: a live socket answers within a
// round trip, and a dead one costs one window instead of two long ones.

export interface ForegroundVerificationPlan {
  windowMs: number;
  /** Silent windows in a row that tear the socket down. */
  silentWindows: number;
}

export const FOREGROUND_WINDOW_MS = 5_000;
export const FOREGROUND_SILENT_WINDOWS = 2;
export const SUSPECT_WINDOW_MIN_MS = 750;
export const SUSPECT_WINDOW_MAX_MS = 2_000;
// Before any round trip is measured, assume a slow mobile link.
const DEFAULT_RTT_MS = 250;

export function planForegroundVerification(input: {
  /** Time since the last inbound frame on this socket. */
  silenceMs: number;
  /**
   * Silence longer than this means the client could not have been running its heartbeat, so the
   * process was suspended or the link stalled. The caller passes its heartbeat interval plus the
   * heartbeat's own timeout: a running, connected client sees a frame at least that often.
   */
  suspectSilenceMs: number;
  lastRttMs: number | null;
  userWaiting: boolean;
}): ForegroundVerificationPlan {
  if (!input.userWaiting && input.silenceMs <= input.suspectSilenceMs) {
    return { windowMs: FOREGROUND_WINDOW_MS, silentWindows: FOREGROUND_SILENT_WINDOWS };
  }
  const rtt = input.lastRttMs ?? DEFAULT_RTT_MS;
  const windowMs = Math.min(SUSPECT_WINDOW_MAX_MS, Math.max(SUSPECT_WINDOW_MIN_MS, 3 * rtt));
  return { windowMs: Math.round(windowMs), silentWindows: 1 };
}
