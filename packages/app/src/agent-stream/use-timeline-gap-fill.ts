import { useEffect, useRef } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { planTimelineGapFetch } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";

// Request the hole while this many loaded rows still separate the reader from it, so the
// page lands before they scroll into the gap.
export const TIMELINE_GAP_PREFETCH_ROWS = 20;

function countLoadedRowsAfter(
  items: readonly StreamItem[],
  epoch: string,
  readingSeq: number,
  endSeq: number,
): number {
  let count = 0;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (cursor?.epoch === epoch && cursor.seq > readingSeq && cursor.seq <= endSeq) count += 1;
  }
  return count;
}

export interface TimelineGapFill {
  reportReadingPosition: (seq: number | null) => void;
}

// After a prompt jump the loaded transcript is the jump window plus the live tail. Load the
// rows between them as the reader approaches the window's newest row.
export function useTimelineGapFill(input: {
  serverId: string;
  agentId: string;
  enabled: boolean;
}): TimelineGapFill {
  const { serverId, agentId, enabled } = input;
  const readingSeqRef = useRef<number | null>(null);
  // Requests by `after` cursor. A settled request is never repeated: its page either moved
  // the range end, or proved there is nothing to merge there.
  const requestedRef = useRef(new Set<string>());
  // A failed request waits for the reader to move before it retries.
  const failedRef = useRef<{ key: string; readingSeq: number } | null>(null);

  const fillGap = useStableEvent(() => {
    const readingSeq = readingSeqRef.current;
    if (!enabled || readingSeq === null) return;
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[serverId],
      agentId,
    );
    if (timeline.status !== "synced" || !timeline.range) return;
    const plan = planTimelineGapFetch({ cursor: timeline.range, readingSeq });
    if (!plan) return;
    const rowsToEdge = countLoadedRowsAfter(
      timeline.items,
      plan.cursor.epoch,
      readingSeq,
      plan.cursor.seq,
    );
    if (rowsToEdge > TIMELINE_GAP_PREFETCH_ROWS) return;
    const key = `${plan.cursor.epoch}:${plan.cursor.seq}`;
    if (requestedRef.current.has(key)) return;
    const failed = failedRef.current;
    if (failed?.key === key && failed.readingSeq === readingSeq) return;
    requestedRef.current.add(key);
    const requested = requestedRef.current;
    getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, plan)
      .catch((error: unknown) => {
        console.warn("[Timeline] failed to load rows after a jump window", agentId, error);
        requested.delete(key);
        if (requestedRef.current === requested) {
          failedRef.current = { key, readingSeq: readingSeqRef.current ?? readingSeq };
        }
      });
  });

  const reportReadingPosition = useStableEvent((seq: number | null) => {
    readingSeqRef.current = seq;
    fillGap();
  });

  useEffect(() => {
    requestedRef.current = new Set();
    failedRef.current = null;
    readingSeqRef.current = null;
  }, [agentId, serverId]);

  // A merged page moves the range end. Check again at the same reading position until the
  // hole closes, since a reader who stops scrolling reports nothing new.
  useEffect(() => {
    if (!enabled) return;
    let cursor = useSessionStore.getState().sessions[serverId]?.agentTimelineCursor.get(agentId);
    return useSessionStore.subscribe((state) => {
      const next = state.sessions[serverId]?.agentTimelineCursor.get(agentId);
      if (next === cursor) return;
      cursor = next;
      fillGap();
    });
  }, [agentId, enabled, fillGap, serverId]);

  return { reportReadingPosition };
}
