import { describe, expect, it } from "vitest";
import {
  PUSH_ATTRIBUTION_WINDOW_MS,
  classifyUntrackedPush,
  planCaughtUpDismissals,
  summarizeHostCatchUp,
  type CaughtUpSince,
  type HostCatchUpSummary,
  type UntrackedPush,
} from "./caught-up";

const GRACE = 1500;

function host(overrides: Partial<HostCatchUpSummary> = {}): HostCatchUpSummary {
  return {
    current: true,
    refreshRequestedAt: 1000,
    finished: [],
    question: [],
    ...overrides,
  };
}

const PUSHES: UntrackedPush[] = [
  { identifier: "finished", kind: "finished", title: "Fix the build", deliveredAt: 500 },
  { identifier: "question", kind: "question", title: "❓️ Fix the build", deliveredAt: 500 },
  { identifier: "test", kind: "test", title: "Paseo", deliveredAt: 500 },
];
const SETTLED: CaughtUpSince = new Map([
  ["finished", 0],
  ["question", 0],
]);

function plan(
  hosts: HostCatchUpSummary[] | null,
  now: number,
  caughtUpSince: CaughtUpSince = new Map(),
  pushes: UntrackedPush[] = PUSHES,
) {
  return planCaughtUpDismissals({ pushes, hosts, caughtUpSince, now, graceMs: GRACE });
}

describe("caught-up dismissal of untracked pushes", () => {
  it("classifies by the daemon's titles", () => {
    expect(classifyUntrackedPush("❓️ Fix the build", "Allow?")).toBe("question");
    expect(classifyUntrackedPush("Fix the build", "Done")).toBe("finished");
    expect(classifyUntrackedPush("Paseo", "Test notification from this host")).toBe("test");
    expect(classifyUntrackedPush("Paseo", "Something else")).toBe("finished");
  });

  it("dismisses both kinds once everything has stayed caught up past the grace, never the test push", () => {
    const first = plan([host(), host()], 2000);
    expect(first.dismiss).toEqual([]);
    expect(first.recheckAt).toBe(2000 + GRACE);
    const later = plan([host(), host()], 2000 + GRACE, first.caughtUpSince);
    expect(later.dismiss).toEqual(["finished", "question"]);
  });

  it("keeps a question while its thread or an agent not yet in the directory waits", () => {
    for (const pushTitle of ["❓️ Fix the build", null]) {
      const hosts = [host(), host({ question: [{ pushTitle, raisedAt: null }] })];
      const settled = plan(hosts, 2000, SETTLED);
      expect(settled.dismiss).toEqual(["finished"]);
      expect(settled.caughtUpSince.has("question")).toBe(false);
    }
  });

  it("dismisses an answered question while another thread's question waits", () => {
    const hosts = [host({ question: [{ pushTitle: "❓️ Other thread", raisedAt: null }] })];
    expect(plan(hosts, 2000, SETTLED).dismiss).toEqual(["finished", "question"]);
  });

  it("keeps a turn end while its thread is unread, however long ago that thread finished", () => {
    const hosts = [host({ finished: [{ pushTitle: "Fix the build", raisedAt: -1e9 }] })];
    expect(plan(hosts, 2000, SETTLED).dismiss).toEqual(["question"]);
  });

  it("keeps a turn end while a renamed thread that finished around it is unread", () => {
    const raisedAt = 500 - PUSH_ATTRIBUTION_WINDOW_MS;
    const hosts = [host({ finished: [{ pushTitle: "Renamed", raisedAt }] })];
    expect(plan(hosts, 2000, SETTLED).dismiss).toEqual(["question"]);
  });

  it("dismisses a read turn end while older unread threads sit elsewhere", () => {
    const raisedAt = 499 - PUSH_ATTRIBUTION_WINDOW_MS;
    const hosts = [
      host({ finished: [{ pushTitle: "Audit shard 1", raisedAt }] }),
      host({ finished: [{ pushTitle: "Audit shard 2", raisedAt: null }] }),
    ];
    expect(plan(hosts, 2000, SETTLED).dismiss).toEqual(["finished", "question"]);
  });

  it("holds everything while a host is offline, unrefreshed or the host list is loading", () => {
    for (const hosts of [[host(), host({ current: false })], [], null]) {
      const settled = plan(hosts, 9000, SETTLED);
      expect(settled).toEqual({ dismiss: [], caughtUpSince: new Map(), recheckAt: null });
    }
  });

  it("keeps a push delivered after the oldest host refresh started", () => {
    const pushes: UntrackedPush[] = [
      { identifier: "old", kind: "finished", title: "Old", deliveredAt: 500 },
      { identifier: "new", kind: "finished", title: "New", deliveredAt: 800 },
    ];
    const hosts = [host({ refreshRequestedAt: 800 }), host({ refreshRequestedAt: 3000 })];
    const since = new Map([
      ["old", 0],
      ["new", 0],
    ]);
    expect(plan(hosts, 9000, since, pushes).dismiss).toEqual(["old"]);
  });

  it("ignores archived agents and subagents, which never get a push of their own", () => {
    const agents = new Map([
      ["archived", { requiresAttention: true, archivedAt: "2026-10-31", parentAgentId: null }],
      ["child", { requiresAttention: true, parentAgentId: "parent" }],
      ["parent", { requiresAttention: false, parentAgentId: null }],
      [
        "errored",
        {
          title: "Fix the build",
          requiresAttention: true,
          attentionReason: "error" as const,
          attentionTimestamp: new Date(42),
          parentAgentId: null,
        },
      ],
    ]);
    expect(
      summarizeHostCatchUp({
        refreshRequestedAt: 1000,
        agents,
        pendingPermissionAgentIds: ["child"],
      }),
    ).toEqual(host({ finished: [{ pushTitle: "❗️ Fix the build", raisedAt: 42 }] }));
    // The daemon's push titles; a request from an agent not in the directory yet is unknown.
    expect(
      summarizeHostCatchUp({
        refreshRequestedAt: 1000,
        agents,
        pendingPermissionAgentIds: ["errored", "new"],
      }).question,
    ).toEqual([
      { pushTitle: "❓️ Fix the build", raisedAt: null },
      { pushTitle: null, raisedAt: null },
    ]);
  });
});
