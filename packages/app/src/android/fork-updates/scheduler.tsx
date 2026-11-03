import { useEffect } from "react";
import { FORK_UPDATE_CHECK_INTERVAL_MS } from "./controller";
import { forkUpdater, isForkUpdaterEnabled, isForkUpdaterShown } from "./updater";

/** Checks for fork Android updates at launch and hourly after; downloading waits for the user. */
export function ForkUpdateScheduler() {
  useEffect(() => {
    if (!isForkUpdaterShown() || !isForkUpdaterEnabled()) return undefined;
    const stop = forkUpdater.start();
    void forkUpdater.send({ type: "check" });
    const interval = setInterval(
      () => void forkUpdater.send({ type: "check" }),
      FORK_UPDATE_CHECK_INTERVAL_MS,
    );
    return () => {
      clearInterval(interval);
      stop();
    };
  }, []);
  return null;
}
