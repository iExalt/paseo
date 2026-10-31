import { describe, expect, it } from "vitest";
import {
  classifyUntrackedPush,
  planCaughtUpDismissals,
  type CaughtUpSince,
  type HostCatchUpSummary,
  type UntrackedPush,
} from "./caught-up";

const GRACE = 1500;

function host(overrides: Partial<HostCatchUpSummary> = {}): HostCatchUpSummary {
  return {
    current: true,
    refreshRequestedAt: 1000,
    anyRequiresAttention: false,
    anyPendingPermission: false,
    ...overrides,
  };
}

const PUSHES: UntrackedPush[] = [
  { identifier: "finished", kind: "finished", deliveredAt: 500 },
  { identifier: "question", kind: "question", deliveredAt: 500 },
  { identifier: "test", kind: "test", deliveredAt: 500 },
];

function plan(
  hosts: HostCatchUpSummary[] | null,
  now: number,
  caughtUpSince: CaughtUpSince = { question: null, finished: null },
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

  it("keeps a question while any host has a pending permission, even with nothing unread", () => {
    const hosts = [host(), host({ anyPendingPermission: true })];
    const settled = plan(hosts, 2000, { question: 0, finished: 0 });
    expect(settled.dismiss).toEqual(["finished"]);
    expect(settled.caughtUpSince.question).toBeNull();
  });

  it("keeps turn ends while any thread on any host is unread", () => {
    const settled = plan([host({ anyRequiresAttention: true })], 2000, {
      question: 0,
      finished: 0,
    });
    expect(settled.dismiss).toEqual(["question"]);
  });

  it("holds everything while a host is offline, unrefreshed or the host list is loading", () => {
    for (const hosts of [[host(), host({ current: false })], [], null]) {
      const settled = plan(hosts, 9000, { question: 0, finished: 0 });
      expect(settled).toEqual({
        dismiss: [],
        caughtUpSince: { question: null, finished: null },
        recheckAt: null,
      });
    }
  });

  it("keeps a push delivered after the oldest host refresh started", () => {
    const pushes: UntrackedPush[] = [
      { identifier: "old", kind: "finished", deliveredAt: 500 },
      { identifier: "new", kind: "finished", deliveredAt: 800 },
    ];
    const hosts = [host({ refreshRequestedAt: 800 }), host({ refreshRequestedAt: 3000 })];
    expect(plan(hosts, 9000, { question: 0, finished: 0 }, pushes).dismiss).toEqual(["old"]);
  });
});
