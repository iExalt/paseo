import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import {
  selectAgentTimelineState,
  useSessionStore,
  type AgentTimelineCursorState,
} from "@/stores/session-store";
import { getEarliestLoadedSeq, planTimelineOlderFetch } from "@/timeline/timeline-sync-plan";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface LoadOlderAgentHistoryClient {
  fetchAgentTimeline: (
    agentId: string,
    request: {
      direction: "before";
      cursor: { epoch: string; seq: number };
      limit: number;
      projection: "projected";
      mergeWindow?: true;
    },
  ) => Promise<unknown>;
}

export interface LoadOlderAgentHistoryLogger {
  warn: (...args: unknown[]) => void;
}

export interface LoadOlderAgentHistoryDeps {
  client: LoadOlderAgentHistoryClient | null;
  cursor: AgentTimelineCursorState | undefined;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  setInFlight: (value: boolean) => void;
  toast?: ToastApi | null;
  logger?: LoadOlderAgentHistoryLogger;
  failedMessage?: string;
}

export async function loadOlderAgentHistory(
  agentId: string,
  deps: LoadOlderAgentHistoryDeps,
): Promise<boolean> {
  const { client, cursor, hasOlder, isLoadingOlder, setInFlight, toast, logger, failedMessage } =
    deps;
  if (isLoadingOlder) {
    return true;
  }
  if (!client || !cursor || !hasOlder) {
    return false;
  }

  setInFlight(true);
  try {
    const plan = planTimelineOlderFetch({ epoch: cursor.epoch, seq: getEarliestLoadedSeq(cursor) });
    // A jump window sits apart from the tail, so its page merges as a window too.
    await client.fetchAgentTimeline(
      agentId,
      cursor.retainedRanges?.length ? { ...plan, mergeWindow: true } : plan,
    );
  } catch (error) {
    (logger ?? console).warn("[Timeline] failed to load older agent history", agentId, error);
    toast?.show(failedMessage ?? i18n.t("loadOlderHistory.failed"), {
      durationMs: 2200,
      testID: "agent-load-older-history-toast",
    });
  } finally {
    setInFlight(false);
  }
  return true;
}

export function useLoadOlderAgentHistory({
  serverId,
  agentId,
  toast,
}: {
  serverId: string;
  agentId: string;
  toast?: ToastApi | null;
}) {
  const { t } = useTranslation();
  const hasOlder = useSessionStore((state) => {
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    return timeline.status === "synced" && timeline.older === "available";
  });
  const isLoadingOlder =
    useSessionStore((state) =>
      state.sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
    ) === true;
  const progressKey = useSessionStore((state) => {
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    const cursor = timeline.status === "synced" ? timeline.range : null;
    return cursor ? `${cursor.epoch}:${getEarliestLoadedSeq(cursor)}` : null;
  });
  const setOlderFetchInFlight = useSessionStore(
    (state) => state.setAgentTimelineOlderFetchInFlight,
  );

  const setInFlight = useCallback(
    (value: boolean) => {
      setOlderFetchInFlight(serverId, (prev) => {
        if (prev.get(agentId) === value) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, value);
        return next;
      });
    },
    [agentId, serverId, setOlderFetchInFlight],
  );

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const session = useSessionStore.getState().sessions[serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    return await loadOlderAgentHistory(agentId, {
      client: session?.client
        ? {
            fetchAgentTimeline: (timelineAgentId, request) =>
              getHostRuntimeStore().fetchAgentTimeline(serverId, timelineAgentId, request),
          }
        : null,
      cursor: timeline.status === "synced" ? (timeline.range ?? undefined) : undefined,
      hasOlder: timeline.status === "synced" && timeline.older === "available",
      isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
      setInFlight,
      toast,
      failedMessage: t("loadOlderHistory.failed"),
    });
  }, [agentId, serverId, setInFlight, toast, t]);

  return {
    isLoadingOlder,
    hasOlder,
    progressKey,
    loadOlder,
  };
}
