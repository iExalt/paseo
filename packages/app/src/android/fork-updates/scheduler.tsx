import { useEffect } from "react";
import {
  FORK_UPDATE_CHECK_INTERVAL_MS,
  checkForForkUpdateNow,
  isForkUpdaterEnabled,
  isForkUpdaterShown,
  startForkUpdates,
} from "./store";

/** Checks for fork Android updates at launch and hourly after; downloading waits for the user. */
export function ForkUpdateScheduler() {
  useEffect(() => {
    if (!isForkUpdaterShown() || !isForkUpdaterEnabled()) return undefined;
    const stop = startForkUpdates();
    void checkForForkUpdateNow({ userInitiated: false });
    const interval = setInterval(
      () => void checkForForkUpdateNow({ userInitiated: false }),
      FORK_UPDATE_CHECK_INTERVAL_MS,
    );
    return () => {
      clearInterval(interval);
      stop();
    };
  }, []);
  return null;
}
