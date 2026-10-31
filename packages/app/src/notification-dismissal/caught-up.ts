import { DISMISS_GRACE_MS } from "./plan";

/**
 * Android pushes delivered while the app isn't running are posted by the Firebase SDK, with
 * only their title and text: nothing says which thread they belong to. They can only go
 * once every host is caught up, judged per kind from the title.
 */
export type UntrackedPushKind = "question" | "finished" | "test";

// The daemon's titles: resolveAgentAttentionTitle in @getpaseo/protocol, and the push test
// in the server's session.ts.
const QUESTION_TITLE_PREFIX = "❓️ ";
const TEST_PUSH_TITLE = "Paseo";
const TEST_PUSH_BODY = "Test notification from this host";

export function classifyUntrackedPush(title: string, body: string): UntrackedPushKind {
  if (title === TEST_PUSH_TITLE && body === TEST_PUSH_BODY) return "test";
  return title.startsWith(QUESTION_TITLE_PREFIX) ? "question" : "finished";
}

export interface UntrackedPush {
  identifier: string;
  kind: UntrackedPushKind;
  /** Device clock delivery time, in milliseconds. */
  deliveredAt: number;
}

export interface HostCatchUpSummary {
  /** Online, with a whole-directory refresh on the current connection. */
  current: boolean;
  refreshRequestedAt: number | null;
  anyRequiresAttention: boolean;
  anyPendingPermission: boolean;
}

/** When each kind was first seen caught up; reset when it stops being. */
export interface CaughtUpSince {
  question: number | null;
  finished: number | null;
}

export interface CaughtUpPlan {
  dismiss: string[];
  caughtUpSince: CaughtUpSince;
  recheckAt: number | null;
}

const NOT_CAUGHT_UP: CaughtUpSince = { question: null, finished: null };

export function planCaughtUpDismissals(input: {
  pushes: readonly UntrackedPush[];
  /** Every configured host; null until the saved host list has loaded. */
  hosts: readonly HostCatchUpSummary[] | null;
  caughtUpSince: CaughtUpSince;
  now: number;
  graceMs?: number;
}): CaughtUpPlan {
  const graceMs = input.graceMs ?? DISMISS_GRACE_MS;
  const hosts = input.hosts;
  // A host this client can't see could be what the push is about.
  if (!hosts || hosts.length === 0 || hosts.some((host) => !host.current)) {
    return { dismiss: [], caughtUpSince: NOT_CAUGHT_UP, recheckAt: null };
  }
  // Pushes carry no host, so only ones every host's latest refresh postdates are settled.
  const cutoff = Math.min(...hosts.map((host) => host.refreshRequestedAt ?? -Infinity));
  const caughtUpSince: CaughtUpSince = {
    question: hosts.some((host) => host.anyPendingPermission)
      ? null
      : (input.caughtUpSince.question ?? input.now),
    finished: hosts.some((host) => host.anyRequiresAttention)
      ? null
      : (input.caughtUpSince.finished ?? input.now),
  };
  const dismiss: string[] = [];
  let recheckAt: number | null = null;
  for (const push of input.pushes) {
    if (push.kind === "test" || push.deliveredAt >= cutoff) continue;
    const since = caughtUpSince[push.kind];
    if (since === null) continue;
    if (input.now >= since + graceMs) {
      dismiss.push(push.identifier);
    } else {
      recheckAt = Math.min(recheckAt ?? Infinity, since + graceMs);
    }
  }
  return { dismiss, caughtUpSince, recheckAt };
}
