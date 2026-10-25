// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type AgentTimelineCursorState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { useTimelineGapFill } from "./use-timeline-gap-fill";

const runtime = vi.hoisted(() => ({ fetchAgentTimeline: vi.fn() }));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ fetchAgentTimeline: runtime.fetchAgentTimeline }),
}));

const SERVER_ID = "gap-fill-host";
const AGENT_ID = "agent-1";

function rows(startSeq: number, endSeq: number): StreamItem[] {
  return Array.from({ length: endSeq - startSeq + 1 }, (_, index) => {
    const seq = startSeq + index;
    return {
      kind: "user_message",
      id: `row-${seq}`,
      text: `prompt ${seq}`,
      timestamp: new Date(seq),
      timelineCursor: { epoch: "epoch-1", seq },
    };
  });
}

function loadTimeline(items: StreamItem[], range: AgentTimelineCursorState): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
    items,
    head: [],
    range,
    older: "none",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

// The live tail holds 51-70; a jump to prompt 12 merged the window 1-32 beside it.
function loadJumpWindow(windowEndSeq = 32): void {
  loadTimeline([...rows(1, windowEndSeq), ...rows(51, 70)], {
    epoch: "epoch-1",
    startSeq: 51,
    endSeq: 70,
    retainedRanges: [{ startSeq: 1, endSeq: windowEndSeq }],
  });
}

function gapRequest(afterSeq: number, limit: number) {
  return {
    direction: "after",
    cursor: { epoch: "epoch-1", seq: afterSeq },
    limit,
    projection: "projected",
    mergeWindow: true,
  };
}

describe("useTimelineGapFill", () => {
  beforeEach(() => {
    runtime.fetchAgentTimeline.mockReset();
    useSessionStore.getState().initializeSession(SERVER_ID, null);
  });
  afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

  it("loads the rows after a jump window as the reader nears its newest row", () => {
    runtime.fetchAgentTimeline.mockReturnValue(new Promise(() => undefined));
    loadJumpWindow();
    const { result } = renderHook(() =>
      useTimelineGapFill({ serverId: SERVER_ID, agentId: AGENT_ID, enabled: true }),
    );

    act(() => result.current.reportReadingPosition(10));
    expect(runtime.fetchAgentTimeline).not.toHaveBeenCalled();

    act(() => result.current.reportReadingPosition(25));
    act(() => result.current.reportReadingPosition(26));
    expect(runtime.fetchAgentTimeline.mock.calls).toEqual([
      [SERVER_ID, AGENT_ID, gapRequest(32, 18)],
    ]);

    // The page merged 33-40: the same reading position now needs the next page.
    act(() => loadJumpWindow(40));
    expect(runtime.fetchAgentTimeline.mock.calls.at(-1)).toEqual([
      SERVER_ID,
      AGENT_ID,
      gapRequest(40, 10),
    ]);
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledTimes(2);
  });

  // A gap page shifts the indices native scrollToIndex aims at mid-jump; see strategy.ts.
  it("requests no gap pages on the native strategy", () => {
    runtime.fetchAgentTimeline.mockReturnValue(new Promise(() => undefined));
    loadJumpWindow();
    const enabledOn = (platform: string) =>
      resolveStreamRenderStrategy({ platform, isMobileBreakpoint: true }).shouldFillTimelineGaps();
    expect(enabledOn("web")).toBe(true);
    const { result } = renderHook(() =>
      useTimelineGapFill({ serverId: SERVER_ID, agentId: AGENT_ID, enabled: enabledOn("android") }),
    );

    act(() => result.current.reportReadingPosition(26));
    act(() => loadJumpWindow(40));
    expect(runtime.fetchAgentTimeline).not.toHaveBeenCalled();
  });

  it("retries a failed page only after the reader moves", async () => {
    runtime.fetchAgentTimeline.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loadJumpWindow();
    const { result } = renderHook(() =>
      useTimelineGapFill({ serverId: SERVER_ID, agentId: AGENT_ID, enabled: true }),
    );

    await act(async () => result.current.reportReadingPosition(25));
    act(() => result.current.reportReadingPosition(25));
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledTimes(1);

    runtime.fetchAgentTimeline.mockReturnValue(new Promise(() => undefined));
    act(() => result.current.reportReadingPosition(26));
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledTimes(2);
    expect(runtime.fetchAgentTimeline.mock.calls[1]).toEqual([
      SERVER_ID,
      AGENT_ID,
      gapRequest(32, 18),
    ]);
  });
});
