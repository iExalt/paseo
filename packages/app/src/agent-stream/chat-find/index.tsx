import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { BackHandler, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { usePaneFindRequest } from "@/pane-find/open-requests";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { setChatFindHighlight } from "./highlight-store";
import { countMessageMatches } from "./message-matches";
import { ChatFindModel, type ChatFindFailure } from "./model";
import type { ChatFindExpansionProps, ChatFindProps } from "./types";

const FAILURE_TEXT: Record<ChatFindFailure, string> = {
  connection: "paneFind.connectionFailure",
  historyChanged: "paneFind.historyChangedFailure",
  reveal: "paneFind.revealFailure",
};
const REVEAL_DEADLINE_MS = 5000;

// Native frames the selected message through the highlight store (row-frame.tsx), so
// no component needs the selected id from context.
export function useChatFindSelectedMessageId(): string | null {
  return null;
}

export function ChatFind({
  agentId,
  serverId,
  epoch,
  items,
  viewportRef,
  revealLoadedMessage,
  visibleMessageIds,
  children,
}: ChatFindProps) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const bindings = useRef({ items, viewportRef, revealLoadedMessage, visibleMessageIds });
  bindings.current = { items, viewportRef, revealLoadedMessage, visibleMessageIds };
  const active = useRetainedPanelActive();
  const model = useMemo(
    () =>
      new ChatFindModel({
        search(query, cursor) {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) return Promise.reject(new Error("Host disconnected"));
          return client.searchAgentTimeline({ agentId, query, cursor });
        },
        load(targetEpoch, seq) {
          return getHostRuntimeStore().fetchAgentTimeline(
            serverId,
            agentId,
            planTimelinePromptJump({ epoch: targetEpoch, seq }),
          );
        },
        // Wait for the message to load, scroll to it, then count its occurrences from
        // the text the reader sees.
        reveal(messageId, query, occurrence, signal) {
          return new Promise((resolve, reject) => {
            const deadline = Date.now() + REVEAL_DEADLINE_MS;
            let frame = 0;
            const cancelled = () => {
              cancelAnimationFrame(frame);
              reject(new Error("Search cancelled"));
            };
            const poll = () => {
              if (signal.aborted) return;
              if (Date.now() >= deadline) {
                signal.removeEventListener("abort", cancelled);
                reject(new Error("Could not reveal this match; retry"));
                return;
              }
              const current = bindings.current;
              if (!current.visibleMessageIds.has(messageId)) {
                current.revealLoadedMessage(messageId);
                frame = requestAnimationFrame(poll);
                return;
              }
              signal.removeEventListener("abort", cancelled);
              const count = countMessageMatches(current.items, messageId, query);
              const index = occurrence < 0 ? count - 1 : Math.min(occurrence, count - 1);
              current.viewportRef.current?.scrollToMessage?.(messageId);
              setChatFindHighlight(
                count > 0 ? { messageId, query, occurrence: Math.max(index, 0) } : null,
              );
              resolve({ occurrence: Math.max(index, 0), count });
            };
            signal.addEventListener("abort", cancelled, { once: true });
            frame = requestAnimationFrame(poll);
          });
        },
        clear() {
          setChatFindHighlight(null);
        },
      }),
    [agentId, serverId],
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    model.updateHistory(epoch, items);
  }, [model, epoch, items]);
  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);
  const openFind = useCallback(() => {
    model.open();
    widget.current?.focus();
  }, [model]);
  usePaneFindRequest(active ? `agent:${agentId}` : null, openFind);
  useEffect(() => {
    if (!state.open) return undefined;
    // Android back closes the find bar before it leaves the screen.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      model.close();
      return true;
    });
    return () => subscription.remove();
  }, [model, state.open]);

  let status = "";
  if (state.phase === "searching") status = t("paneFind.searching");
  else if (state.phase === "loading") status = t("paneFind.loading");
  else if (state.phase === "error") status = t("paneFind.failed");
  else if (state.query.trim())
    status = state.count
      ? t("paneFind.position", { current: state.occurrence + 1, total: state.count })
      : t("paneFind.noMatches");
  return (
    <View style={styles.root}>
      {children}
      {state.open ? (
        <View style={styles.overlay}>
          <PaneFind
            ref={widget}
            query={state.query}
            status={status}
            canNavigate={state.phase === "ready" && state.count > 0}
            onQueryChange={model.setQuery}
            onNext={model.next}
            onPrevious={model.previous}
            onClose={model.close}
          />
          {state.failure ? (
            <View style={styles.error}>
              <Text style={styles.errorText}>{t(FAILURE_TEXT[state.failure])}</Text>
              <Button size="xs" variant="ghost" onPress={model.retry}>
                {t("paneFind.retry")}
              </Button>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function ChatFindExpansion({ children }: ChatFindExpansionProps) {
  return children(false);
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 10,
  },
  error: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  errorText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
}));
