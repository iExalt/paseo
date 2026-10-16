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
import { findRevealDelta } from "@/find-highlight/reveal";
import type { StreamViewportHandle } from "../strategy";
import { getChatFindAnchor, setChatFindHighlight } from "./highlight-store";
import { locateMessageMatch } from "./message-matches";
import { ChatFindModel, type ChatFindFailure } from "./model";
import type { ChatFindExpansionProps, ChatFindProps } from "./types";

const FAILURE_TEXT: Record<ChatFindFailure, string> = {
  connection: "paneFind.connectionFailure",
  historyChanged: "paneFind.historyChangedFailure",
  reveal: "paneFind.revealFailure",
};
const REVEAL_DEADLINE_MS = 5000;
const NO_MATCH = { occurrence: 0, count: 0 };
// Frames to wait for the selected occurrence's Text to draw: briefly where its row is
// already mounted, longer after jumping to a row that has to mount first.
const ANCHOR_SETTLE_FRAMES = 6;
const ANCHOR_JUMP_FRAMES = 30;
const REVEAL_MARGIN = 8;

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
  const root = useRef<View>(null);
  const overlay = useRef<View>(null);
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
        // Wait for the message to load, find the occurrence in the text the rows draw,
        // then scroll until it shows above the find bar.
        reveal(messageId, query, occurrence, signal) {
          return new Promise((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("Search cancelled"));
              return;
            }
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
              const match = locateMessageMatch(current.items, messageId, query, occurrence);
              setChatFindHighlight(
                match ? { messageId, itemId: match.itemId, query, index: match.index } : null,
              );
              if (!match) {
                resolve(NO_MATCH);
                return;
              }
              void revealOccurrence({
                itemId: match.itemId,
                index: match.index,
                viewport: current.viewportRef.current,
                band: () => measureBand(root.current, overlay.current),
                signal,
              }).then(() => resolve({ occurrence: match.occurrence, count: match.count }));
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
    <View ref={root} style={styles.root}>
      {children}
      {state.open ? (
        <View ref={overlay} style={styles.overlay}>
          <PaneFind
            ref={widget}
            fill
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function measureTop(view: View | null): Promise<{ top: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!view) resolve(null);
    else view.measureInWindow((_x, top, _width, height) => resolve({ top, height }));
  });
}

/** The part of the chat the reader can see: from its top down to the find bar. */
async function measureBand(
  chat: View | null,
  bar: View | null,
): Promise<{ top: number; bottom: number } | null> {
  const [chatRect, barRect] = await Promise.all([measureTop(chat), measureTop(bar)]);
  if (!chatRect) return null;
  return { top: chatRect.top, bottom: barRect ? barRect.top : chatRect.top + chatRect.height };
}

async function measureAnchor(
  itemId: string,
  index: number,
  frames: number,
  signal: AbortSignal,
): Promise<{ top: number; height: number } | null> {
  for (let frame = 0; frame < frames && !signal.aborted; frame += 1) {
    const rect = await getChatFindAnchor(itemId, index)?.measure();
    if (rect) return rect;
    await nextFrame();
  }
  return null;
}

/**
 * Brings the selected occurrence into view. A drawn occurrence is measured where it is,
 * so one already in view does not move. Otherwise the row holding it jumps to the top
 * first; a row taller than the screen is then measured again to reach the line. Where
 * nothing can be measured (iOS Markdown text), the row jump is as far as it goes.
 */
async function revealOccurrence({
  itemId,
  index,
  viewport,
  band,
  signal,
}: {
  itemId: string;
  index: number;
  viewport: StreamViewportHandle | null;
  band: () => Promise<{ top: number; bottom: number } | null>;
  signal: AbortSignal;
}): Promise<void> {
  if (!viewport) return;
  let rect = await measureAnchor(itemId, index, ANCHOR_SETTLE_FRAMES, signal);
  if (!rect) {
    viewport.scrollToItem?.(itemId);
    await nextFrame();
    await nextFrame();
    rect = await measureAnchor(itemId, index, ANCHOR_JUMP_FRAMES, signal);
  }
  const visible = rect && !signal.aborted ? await band() : null;
  if (!rect || !visible) return;
  const delta = findRevealDelta({
    visibleTop: visible.top,
    visibleBottom: visible.bottom,
    matchTop: rect.top,
    matchHeight: rect.height,
    margin: REVEAL_MARGIN,
  });
  if (delta !== 0) viewport.scrollByWindowDelta?.(delta);
}

export function ChatFindExpansion({ children }: ChatFindExpansionProps) {
  return children(false);
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  // Bottom, not top: the keyboard shift translates the pane up while the find field
  // has focus, which would carry a top bar off screen.
  overlay: {
    position: "absolute",
    bottom: theme.spacing[2],
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
