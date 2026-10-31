import { describe, expect, it } from "vitest";
import { agentNotificationKey, parseAgentNotificationKey, readAgentNotificationData } from "./key";
import {
  planNotificationDismissals,
  type AgentDismissalView,
  type HostDismissalView,
  type TrackedNotification,
} from "./plan";

const GRACE = 1_000;

function entry(overrides: Partial<TrackedNotification> = {}): TrackedNotification {
  const serverId = overrides.serverId ?? "host";
  const agentId = overrides.agentId ?? "agent";
  return {
    key: agentNotificationKey({ serverId, agentId }),
    serverId,
    agentId,
    reason: "finished",
    createdAt: 100,
    armed: false,
    resolvedSince: null,
    absenceRefreshRequested: false,
    ...overrides,
  };
}

function host(
  options: {
    current?: boolean;
    refreshRequestedAt?: number | null;
    agent?: AgentDismissalView | null;
    pendingPermission?: boolean;
  } = {},
): HostDismissalView {
  return {
    current: options.current ?? true,
    refreshRequestedAt: options.refreshRequestedAt ?? null,
    agent: () =>
      options.agent === undefined ? { requiresAttention: false, archived: false } : options.agent,
    hasPendingPermission: () => options.pendingPermission ?? false,
  };
}

function plan(
  entries: TrackedNotification[],
  hostView: HostDismissalView | null,
  now = 200,
  hostsLoaded = true,
) {
  return planNotificationDismissals({
    entries,
    hostsLoaded,
    host: () => hostView,
    now,
    graceMs: GRACE,
  });
}

describe("planNotificationDismissals", () => {
  it("keeps everything until the saved host list has loaded", () => {
    const result = plan([entry({ armed: true })], null, 200, false);
    expect(result.dismiss).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it("dismisses at once when the host was removed from the app", () => {
    expect(plan([entry()], null).dismiss).toEqual([entry().key]);
  });

  it("keeps entries unchanged while the host has no current directory", () => {
    const tracked = entry({ armed: true, resolvedSince: 150 });
    const result = plan([tracked], host({ current: false }), 10_000);
    expect(result).toEqual({ entries: [tracked], dismiss: [], refresh: [], recheckAt: null });
  });

  it("dismisses an archived agent at once, even unarmed or with a pending question", () => {
    const archived = host({
      agent: { requiresAttention: true, archived: true },
      pendingPermission: true,
    });
    expect(plan([entry({ reason: "permission" })], archived).dismiss).toEqual([entry().key]);
  });

  it("keeps an unarmed notification whose state predates it", () => {
    // The attention event outran the agent update that sets requiresAttention.
    const result = plan([entry()], host({ refreshRequestedAt: 50 }), 10_000);
    expect(result.dismiss).toEqual([]);
    expect(result.entries[0]?.armed).toBe(false);
  });

  it("arms when the condition is seen active, then dismisses after the grace period", () => {
    const active = plan([entry()], host({ agent: { requiresAttention: true, archived: false } }));
    expect(active.entries[0]).toMatchObject({ armed: true, resolvedSince: null });

    const read = plan(active.entries, host(), 300);
    expect(read.dismiss).toEqual([]);
    expect(read.recheckAt).toBe(1_300);

    expect(plan(read.entries, host(), 1_299).dismiss).toEqual([]);
    expect(plan(read.entries, host(), 1_300).dismiss).toEqual([entry().key]);
  });

  it("arms from a directory refresh requested after the notification", () => {
    // Read elsewhere before this client saw the attention state.
    const result = plan([entry()], host({ refreshRequestedAt: 101 }), 200);
    expect(result.entries[0]).toMatchObject({ armed: true, resolvedSince: 200 });
  });

  it("does not dismiss when a stale update briefly reports resolved", () => {
    const armed = entry({ armed: true });
    const flicker = plan([armed], host(), 200);
    const back = plan(
      flicker.entries,
      host({ agent: { requiresAttention: true, archived: false } }),
      500,
    );
    expect(back.entries[0]).toMatchObject({ resolvedSince: null });
    expect(plan(back.entries, host(), 1_300).dismiss).toEqual([]);
  });

  it("keeps a question after the thread is read, until the request resolves", () => {
    const question = entry({ reason: "permission", armed: true });
    const read = host({
      agent: { requiresAttention: false, archived: false },
      pendingPermission: true,
    });
    expect(plan([question], read, 10_000).dismiss).toEqual([]);
    const resolved = plan([question], host(), 10_000);
    expect(plan(resolved.entries, host(), 11_000).dismiss).toEqual([question.key]);
  });

  it("treats an agent missing from the directory as resolved, behind arming and grace", () => {
    const unarmed = plan([entry()], host({ agent: null, refreshRequestedAt: 50 }), 10_000);
    expect(unarmed.dismiss).toEqual([]);
    const armed = plan([entry({ armed: true })], host({ agent: null }), 200);
    expect(plan(armed.entries, host({ agent: null }), 1_200).dismiss).toEqual([entry().key]);
  });

  it("refreshes once when a missing agent's notification cannot arm", () => {
    // Archived before this client saw it, on a connection whose directory is already current.
    const missing = host({ agent: null, refreshRequestedAt: 50 });
    const early = plan([entry()], missing, 600);
    expect(early.refresh).toEqual([]);
    expect(early.recheckAt).toBe(1_100);
    const due = plan(early.entries, missing, 1_100);
    expect(due.refresh).toEqual(["host"]);
    expect(plan(due.entries, missing, 5_000).refresh).toEqual([]);
    const refreshed = plan(due.entries, host({ agent: null, refreshRequestedAt: 1_150 }), 1_200);
    expect(plan(refreshed.entries, host({ agent: null }), 2_200).dismiss).toEqual([entry().key]);
  });

  it("keeps an unknown-reason entry while either attention or a question is pending", () => {
    const unknown = entry({ reason: "unknown", armed: true });
    const question = host({ pendingPermission: true });
    expect(plan([unknown], question).entries[0]?.resolvedSince).toBeNull();
    const unread = host({ agent: { requiresAttention: true, archived: false } });
    expect(plan([unknown], unread).entries[0]?.resolvedSince).toBeNull();
  });

  it("reports the earliest pending grace deadline", () => {
    const a = entry({ agentId: "a", armed: true, resolvedSince: 500 });
    const b = entry({ agentId: "b", armed: true, resolvedSince: 300 });
    expect(plan([a, b], host(), 600).recheckAt).toBe(1_300);
  });
});

describe("agent notification keys", () => {
  it("round-trips ids containing the separator", () => {
    const identity = { serverId: "srv:with:colons", agentId: "a/b%c" };
    expect(parseAgentNotificationKey(agentNotificationKey(identity))).toEqual(identity);
  });

  it("rejects keys it did not make", () => {
    expect(parseAgentNotificationKey("paseo-terminal:x:y")).toBeNull();
    expect(parseAgentNotificationKey("paseo-agent:x")).toBeNull();
    expect(parseAgentNotificationKey("paseo-agent:%E0%A4%A:y")).toBeNull();
  });

  it("reads only agent-attention payloads", () => {
    expect(
      readAgentNotificationData({ serverId: "s", agentId: "a", reason: "permission" }),
    ).toEqual({ serverId: "s", agentId: "a", reason: "permission" });
    expect(
      readAgentNotificationData({ serverId: "s", workspaceId: "w", terminalId: "t" }),
    ).toBeNull();
    expect(readAgentNotificationData({ serverId: "s", agentId: "a" })).toBeNull();
    expect(readAgentNotificationData(null)).toBeNull();
  });
});
