import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  shouldClearAgentAttention,
  type AgentAttentionClearTrigger,
} from "@/utils/agent-attention";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";

type AttentionReason = "finished" | "error" | "permission" | null | undefined;

/**
 * After a thread is opened, how long its state may keep arriving (host connecting, directory
 * hydrating) and still count as seen on entry rather than as a new turn ending while watched.
 */
const ENTRY_SETTLE_MS = 5_000;

interface UseAgentAttentionClearParams {
  agentId: string | null | undefined;
  client: DaemonClient | null;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason: AttentionReason;
  isScreenFocused: boolean;
}

interface AgentAttentionClearController {
  clearOnInputFocus: () => void;
  clearOnPromptSend: () => void;
  clearOnAgentBlur: () => void;
}

export function useAgentAttentionClear({
  agentId,
  client,
  isConnected,
  requiresAttention,
  attentionReason,
  isScreenFocused,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const deferredFocusEntryClearRef = useRef(false);
  const prevRequiresAttentionRef = useRef(Boolean(requiresAttention));
  const prevActivelyViewedRef = useRef(isScreenFocused && getIsAppActivelyVisible());
  const prevScreenFocusedRef = useRef(false);
  const prevAppVisibleRef = useRef(getIsAppActivelyVisible());
  // Set on entering the thread until a clear is sent or the entry settles. A cold start
  // focuses the thread before the host connects and before its attention state arrives.
  const entryClearPendingRef = useRef(false);
  const [entrySettleKey, setEntrySettleKey] = useState(0);

  const clearAttention = useCallback(
    (trigger: AgentAttentionClearTrigger) => {
      const resolvedAgentId = agentId?.trim();
      if (!client || !resolvedAgentId) {
        return;
      }
      if (
        !shouldClearAgentAttention({
          agentId: resolvedAgentId,
          isConnected,
          requiresAttention,
          attentionReason,
          trigger,
          hasDeferredFocusEntryClear: deferredFocusEntryClearRef.current,
        })
      ) {
        return;
      }
      deferredFocusEntryClearRef.current = false;
      entryClearPendingRef.current = false;
      client.clearAgentAttention(resolvedAgentId).catch(() => {});
    },
    [agentId, attentionReason, client, isConnected, requiresAttention],
  );

  useEffect(() => {
    const updateVisibility = () => {
      setIsAppVisible(getIsAppActivelyVisible());
    };

    const appStateSubscription = AppState.addEventListener("change", updateVisibility);

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updateVisibility);
      window.addEventListener("focus", updateVisibility);
      window.addEventListener("blur", updateVisibility);

      return () => {
        appStateSubscription.remove();
        document.removeEventListener("visibilitychange", updateVisibility);
        window.removeEventListener("focus", updateVisibility);
        window.removeEventListener("blur", updateVisibility);
      };
    }

    return () => {
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!requiresAttention) {
      deferredFocusEntryClearRef.current = false;
    }
  }, [requiresAttention]);

  useEffect(() => {
    const isActivelyViewed = isScreenFocused && isAppVisible;
    if (
      !entryClearPendingRef.current &&
      !prevRequiresAttentionRef.current &&
      Boolean(requiresAttention) &&
      prevActivelyViewedRef.current &&
      isActivelyViewed
    ) {
      deferredFocusEntryClearRef.current = true;
    }
    prevRequiresAttentionRef.current = Boolean(requiresAttention);
    prevActivelyViewedRef.current = isActivelyViewed;
  }, [isAppVisible, isScreenFocused, requiresAttention]);

  useEffect(() => {
    const enteredScreenFocus = !prevScreenFocusedRef.current && isScreenFocused && isAppVisible;
    const resumedIntoFocusedAgent = !prevAppVisibleRef.current && isAppVisible && isScreenFocused;

    if (enteredScreenFocus || resumedIntoFocusedAgent) {
      entryClearPendingRef.current = true;
      setEntrySettleKey((key) => key + 1);
      clearAttention("focus-entry");
    }
    if (!isScreenFocused || !isAppVisible) entryClearPendingRef.current = false;

    prevScreenFocusedRef.current = isScreenFocused;
    prevAppVisibleRef.current = isAppVisible;
  }, [clearAttention, isAppVisible, isScreenFocused]);

  // The entry clear above was refused while disconnected or before attention arrived.
  useEffect(() => {
    if (entryClearPendingRef.current && isScreenFocused && isAppVisible) {
      clearAttention("focus-entry");
    }
  }, [clearAttention, isAppVisible, isScreenFocused]);

  useEffect(() => {
    if (!isConnected || entrySettleKey === 0) return;
    const timer = setTimeout(() => {
      entryClearPendingRef.current = false;
    }, ENTRY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [entrySettleKey, isConnected]);

  return {
    clearOnInputFocus: useCallback(() => {
      clearAttention("input-focus");
    }, [clearAttention]),
    clearOnPromptSend: useCallback(() => {
      clearAttention("prompt-send");
    }, [clearAttention]),
    clearOnAgentBlur: useCallback(() => {
      clearAttention("agent-blur");
    }, [clearAttention]),
  };
}
