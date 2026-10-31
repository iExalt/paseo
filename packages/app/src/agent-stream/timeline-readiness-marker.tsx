import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import type { AgentScreenReadySyncState } from "@/hooks/use-agent-screen-state-machine";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { agentLog } from "@/utils/agent-log";
import {
  closedTurnsKey,
  readClosedTurns,
  recordTurnActivity,
  resolveTimelineReadiness,
  retainTurnCounter,
  subscribeClosedTurns,
} from "./timeline-readiness";

/** Counts this chat's closed turns, including while its panel is hidden. */
export function useCountClosedTurns(serverId: string, agentId: string): void {
  useEffect(() => {
    const key = closedTurnsKey(serverId, agentId);
    // A store subscription sees every state the store passes through, not only rendered ones.
    return retainTurnCounter(key, () =>
      useSessionStore.subscribe(
        (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isActive,
        (isActive, wasActive) => recordTurnActivity(key, wasActive, isActive),
      ),
    );
  }, [serverId, agentId]);
}

/**
 * An invisible node naming the open chat's readiness: `agent-timeline-<state>` as a testID, with
 * `data-agent-id` and `data-turns` on web. Render it only for the visible chat.
 */
export function TimelineReadinessMarker({
  serverId,
  agentId,
  sync,
}: {
  serverId: string;
  agentId: string;
  sync: AgentScreenReadySyncState;
}) {
  const isTurnActive = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isActive,
  );
  const key = closedTurnsKey(serverId, agentId);
  const readTurns = useCallback(() => readClosedTurns(key), [key]);
  const turns = useSyncExternalStore(subscribeClosedTurns, readTurns, readTurns);
  const readiness = resolveTimelineReadiness({ sync: sync.status, isTurnActive });
  const dataSet = useMemo(() => ({ agentId, turns }), [agentId, turns]);

  useEffect(() => {
    agentLog("timeline", "state", { agentId, state: readiness, turns });
  }, [agentId, readiness, turns]);

  return (
    <View
      testID={`agent-timeline-${readiness}`}
      dataSet={dataSet}
      collapsable={false}
      pointerEvents="none"
      style={styles.marker}
    />
  );
}

// 1×1 rather than empty: Playwright treats a zero-size node as hidden.
const styles = StyleSheet.create({
  marker: { position: "absolute", top: 0, left: 0, width: 1, height: 1, opacity: 0 },
});
