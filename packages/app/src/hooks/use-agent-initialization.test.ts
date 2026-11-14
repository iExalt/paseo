import { TimelineRequestSupersededError } from "@/timeline/timeline-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import {
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  createSetAgentInitializing,
  ensureAgentIsInitialized,
  refreshAgentInitializationTimeout,
  refreshAgent,
} from "./use-agent-initialization";

const serverId = "server-1";
const agentId = "agent-1";

class FakeDaemonClient {
  readonly refreshedAgentIds: string[] = [];

  async refreshAgent(requestedAgentId: string): Promise<void> {
    this.refreshedAgentIds.push(requestedAgentId);
  }
}

class FakeTimelineRuntime {
  readonly requests: Array<{
    serverId: string;
    agentId: string;
    request: Parameters<HostRuntimeStore["fetchAgentTimeline"]>[2];
  }> = [];

  fetchAgentTimeline: HostRuntimeStore["fetchAgentTimeline"] = async (
    requestedServerId,
    requestedAgentId,
    request,
  ) => {
    this.requests.push({ serverId: requestedServerId, agentId: requestedAgentId, request });
    return undefined as never;
  };
}

function bindSetAgentInitializing() {
  return createSetAgentInitializing(serverId, useSessionStore.getState().setInitializingAgents);
}

afterEach(() => {
  resolveInitDeferred(getInitKey(serverId, agentId));
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  vi.restoreAllMocks();
});

describe("ensureAgentIsInitialized", () => {
  it("catches up after loaded authoritative history", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        serverId,
        new Map([[agentId, { epoch: "epoch-1", startSeq: 1, endSeq: 42 }]]),
      );
    useSessionStore.getState().setAgentAuthoritativeHistoryApplied(serverId, agentId, true);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "after",
          cursor: { epoch: "epoch-1", seq: 42 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
          wholeTurns: true,
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("requests a bounded projected tail when no authoritative cursor is available", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
          wholeTurns: true,
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("tail");
  });

  it("requests a bounded projected tail after restoring painted replica items", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, null);
    useSessionStore.getState().applyAgentTimelineResponseState(serverId, agentId, {
      items: [
        {
          kind: "assistant_message",
          id: "painted-item",
          text: "Painted before hydration",
          timestamp: new Date("2026-07-27T10:00:00.000Z"),
        },
      ],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: false,
      acknowledgedClientMessageIds: [],
    });

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
          wholeTurns: true,
        },
      },
    ]);
  });

  it("catches up after the restored canonical replica range", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, null);
    useSessionStore.getState().applyAgentTimelineResponseState(serverId, agentId, {
      items: [
        {
          kind: "assistant_message",
          id: "canonical-item",
          text: "Canonical before restart",
          timelineCursor: { epoch: "epoch-1", seq: 12 },
          timestamp: new Date("2026-07-27T10:00:00.000Z"),
        },
      ],
      head: [],
      range: { epoch: "epoch-1", startSeq: 10, endSeq: 12 },
      older: "available",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "after",
          cursor: { epoch: "epoch-1", seq: 12 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
          wholeTurns: true,
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("times out initialization after 65 seconds", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    vi.advanceTimersByTime(64_999);
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeDefined();

    vi.advanceTimersByTime(1);

    await expect(promise).rejects.toThrow("History sync timed out after 65s");
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeUndefined();
    expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(
      false,
    );
    vi.useRealTimers();
  });

  it("refreshes the initialization timeout after paged catch-up progress", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    const setAgentInitializing = bindSetAgentInitializing();
    const key = getInitKey(serverId, agentId);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing,
    });

    vi.advanceTimersByTime(64_999);
    refreshAgentInitializationTimeout({ key, agentId, setAgentInitializing });

    vi.advanceTimersByTime(1);
    expect(getInitDeferred(key)).toBeDefined();

    const rejection = expect(promise).rejects.toThrow("History sync timed out after 65s");

    vi.advanceTimersByTime(64_998);
    expect(getInitDeferred(key)).toBeDefined();

    vi.advanceTimersByTime(1);

    await rejection;
    expect(getInitDeferred(key)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("refreshAgent", () => {
  it("fetches a bounded projected tail after refreshing the agent", async () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    await refreshAgent({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(client.refreshedAgentIds).toEqual([agentId]);
    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
          wholeTurns: true,
        },
      },
    ]);
  });
});

it("does not reject a newer initialization when an old fetch fails", async () => {
  useSessionStore.getState().initializeSession(serverId, null);
  let fail!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const runtime = { fetchAgentTimeline: () => pending };
  const first = ensureAgentIsInitialized({
    serverId,
    agentId,
    client: {} as never,
    runtime,
    setAgentInitializing: bindSetAgentInitializing(),
  });
  resolveInitDeferred(getInitKey(serverId, agentId));
  await first;
  const current = createInitDeferred(getInitKey(serverId, agentId), "tail");
  void current.promise.catch(() => {});
  useSessionStore.getState().setInitializingAgents(serverId, new Map([[agentId, true]]));
  fail(new Error("old connection"));
  await pending.catch(() => {});
  expect(getInitDeferred(getInitKey(serverId, agentId))).toBe(current);
  expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(true);
});

it("settles its own superseded initialization without claiming synchronization", async () => {
  useSessionStore.getState().initializeSession(serverId, null);
  let fail!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const initialized = ensureAgentIsInitialized({
    serverId,
    agentId,
    client: {} as never,
    runtime: { fetchAgentTimeline: () => pending },
    setAgentInitializing: bindSetAgentInitializing(),
  });
  const rejected = expect(initialized).rejects.toBeInstanceOf(TimelineRequestSupersededError);
  fail(new TimelineRequestSupersededError());
  await rejected;
  expect(getInitDeferred(getInitKey(serverId, agentId))).toBeUndefined();
  expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(
    false,
  );
  expect(
    useSessionStore.getState().sessions[serverId]?.agentAuthoritativeHistoryApplied.get(agentId),
  ).not.toBe(true);
});
