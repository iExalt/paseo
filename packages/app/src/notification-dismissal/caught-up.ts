import {
  resolveAgentAttentionTitle,
  type AgentAttentionReason,
} from "@getpaseo/protocol/agent-attention-notification";
import { DISMISS_GRACE_MS } from "./plan";

/**
 * Android pushes delivered while the app isn't running are posted by the Firebase SDK, with
 * only their title and text: nothing says which thread they belong to. They can only go
 * once every host is caught up on whatever could have raised them: a waiting thread holds a
 * push of its kind only if the push has its title or its attention is recent (see
 * blockerHoldsPush).
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
  /** The notification's title, as the daemon wrote it. */
  title: string;
  /** Device clock delivery time, in milliseconds. */
  deliveredAt: number;
}

/**
 * A thread still waiting on the user: a top-level agent with unread attention (finished) or
 * a pending permission (question).
 */
export interface CatchUpBlocker {
  /** The push title the daemon would give it; null when its agent isn't in the directory. */
  pushTitle: string | null;
  /**
   * When it started waiting, on the daemon's clock; null when unknown, which leaves the title
   * alone to decide. Questions have none: a permission request sets no attention timestamp.
   */
  raisedAt: number | null;
}

export interface HostCatchUpSummary {
  /** Online, with a whole-directory refresh on the current connection. */
  current: boolean;
  refreshRequestedAt: number | null;
  finished: CatchUpBlocker[];
  question: CatchUpBlocker[];
}

export interface CatchUpAgent {
  title?: string | null;
  requiresAttention?: boolean | null;
  attentionReason?: AgentAttentionReason | null;
  attentionTimestamp?: Date | null;
  archivedAt?: unknown;
  parentAgentId?: string | null;
}

/**
 * Subagents get attention and permission requests but never a push, and no UI asks the user
 * to clear them, so they can't be what a push is about and must not hold it.
 */
export function summarizeHostCatchUp(input: {
  refreshRequestedAt: number | null;
  agents: ReadonlyMap<string, CatchUpAgent>;
  pendingPermissionAgentIds: Iterable<string>;
}): HostCatchUpSummary {
  const isSubagent = (agent: CatchUpAgent | undefined) => !!agent?.parentAgentId;
  const finished: CatchUpBlocker[] = [];
  for (const agent of input.agents.values()) {
    if (agent.requiresAttention === true && !agent.archivedAt && !isSubagent(agent)) {
      const reason = agent.attentionReason === "error" ? "error" : "finished";
      finished.push({
        pushTitle: resolveAgentAttentionTitle(reason, agent.title),
        raisedAt: agent.attentionTimestamp?.getTime() ?? null,
      });
    }
  }
  const question: CatchUpBlocker[] = [];
  for (const agentId of new Set(input.pendingPermissionAgentIds)) {
    const agent = input.agents.get(agentId);
    if (isSubagent(agent)) continue;
    question.push({
      pushTitle: agent ? resolveAgentAttentionTitle("permission", agent.title) : null,
      raisedAt: null,
    });
  }
  return {
    current: input.refreshRequestedAt !== null,
    refreshRequestedAt: input.refreshRequestedAt,
    finished,
    question,
  };
}

/**
 * How long before a push arrived a waiting thread's attention may have been raised and still
 * be what the push is about, when the titles differ (the thread was renamed after the push).
 * It also covers clock skew and delivery delay between the daemon and the phone.
 */
export const PUSH_ATTRIBUTION_WINDOW_MS = 10 * 60_000;

/**
 * Whether a waiting thread could be what a push is about: the push carries its title, its
 * agent isn't in the directory yet, or it started waiting around or after the push. Without this, any old unread thread would
 * keep every push in the shade forever.
 */
export function blockerHoldsPush(blocker: CatchUpBlocker, push: UntrackedPush): boolean {
  if (blocker.pushTitle === null || blocker.pushTitle === push.title) return true;
  return (
    blocker.raisedAt !== null && blocker.raisedAt >= push.deliveredAt - PUSH_ATTRIBUTION_WINDOW_MS
  );
}

/** When each push was first seen with nothing holding it, by identifier. */
export type CaughtUpSince = ReadonlyMap<string, number>;

export interface CaughtUpPlan {
  dismiss: string[];
  caughtUpSince: CaughtUpSince;
  recheckAt: number | null;
}

const NOT_CAUGHT_UP: CaughtUpSince = new Map();

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
  const caughtUpSince = new Map<string, number>();
  const dismiss: string[] = [];
  let recheckAt: number | null = null;
  for (const push of input.pushes) {
    const kind = push.kind;
    if (kind === "test" || push.deliveredAt >= cutoff) continue;
    const held = hosts.some((host) =>
      host[kind].some((blocker) => blockerHoldsPush(blocker, push)),
    );
    if (held) continue;
    const since = input.caughtUpSince.get(push.identifier) ?? input.now;
    caughtUpSince.set(push.identifier, since);
    if (input.now >= since + graceMs) {
      dismiss.push(push.identifier);
    } else {
      recheckAt = Math.min(recheckAt ?? Infinity, since + graceMs);
    }
  }
  return { dismiss, caughtUpSince, recheckAt };
}
