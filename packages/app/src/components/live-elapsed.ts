import { useEffect, useState } from "react";
import { readAgentSwitch } from "@/diagnostics/agent-switches";

// Repeated here, not imported, so bundles without the flag still fold it away.
const SWITCHES_ENABLED = process.env.EXPO_PUBLIC_PASEO_AGENT_SWITCHES === "1";

/**
 * Milliseconds since `startedAtMs`, re-rendering every second while `active`. The `clock=frozen`
 * agent switch stops the tick, since a label that changes every second keeps uiautomator from
 * going idle; the value still updates whenever the caller renders.
 */
export function useLiveElapsedMs(startedAtMs: number, active: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startedAtMs));
  const frozen = SWITCHES_ENABLED && readAgentSwitch("clock") === "frozen";

  useEffect(() => {
    if (!active || frozen) {
      return;
    }
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const handle = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 1000);
    return () => clearInterval(handle);
  }, [active, frozen, startedAtMs]);

  return active ? Math.max(0, Date.now() - startedAtMs) : elapsedMs;
}
