import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { Logger } from "pino";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
} from "./agent-attention-policy.js";
import type { CompletionSubject } from "./agent/completion-subject.js";
import { classifyReplySubject, type ReplyRule } from "./agent/reply-rule-matcher.js";
import type { DaemonConfigStore, MutableDaemonConfig } from "./daemon-config-store.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

// The fork's notification policy: who may change it (workspace mute, daemon reply rules),
// in what order a change commits and is published, and whether one attention event
// pushes, notifies one client in-app, or stays silent. Session RPCs, the agent tools,
// bootstrap and the websocket broadcasts call it; upstream's computeNotificationPlan
// still decides presence and focus.

/**
 * Shared readiness gate for accepting workspace notification policy and advertising support.
 * Enable only after both agent and terminal delivery enforce the persisted policy.
 */
export const WORKSPACE_NOTIFICATIONS_ENABLED = true;

export type WorkspaceNotifications = PersistedWorkspaceRecord["notifications"];

export function readReplyRules(store: Pick<DaemonConfigStore, "getReplyRules">): ReplyRule[] {
  return [...store.getReplyRules()];
}

/** Resolves once the rules are persisted, with the rules as committed. */
export async function writeReplyRules(
  store: Pick<DaemonConfigStore, "getReplyRules" | "patch">,
  replyRules: ReplyRule[],
): Promise<ReplyRule[]> {
  await store.patch({ replyRules });
  return readReplyRules(store);
}

/** Clients without reply-rule support see the daemon config without the rules. */
export function daemonConfigForClient(
  config: MutableDaemonConfig,
  supportsReplyRules: boolean,
): MutableDaemonConfig {
  if (supportsReplyRules) return config;
  const { replyRules: _replyRules, ...legacyConfig } = config;
  return legacyConfig as MutableDaemonConfig;
}

/** Persists a workspace's notification policy; null when the workspace is unknown. */
export function setWorkspaceNotifications(
  registry: Pick<WorkspaceRegistry, "update">,
  workspaceId: string,
  notifications: WorkspaceNotifications,
): Promise<PersistedWorkspaceRecord | null> {
  return registry.update(workspaceId, (workspace) => ({
    ...workspace,
    notifications,
    updatedAt: new Date().toISOString(),
  }));
}

export type AttentionTarget =
  | {
      kind: "agent";
      agentId: string;
      reason: AgentAttentionReason;
      completionSubject?: CompletionSubject;
    }
  | { kind: "terminal"; terminalId: string };

export interface NotificationPolicySources {
  daemonConfig: Pick<DaemonConfigStore, "getReplyRules" | "matchesReplyRules">;
  workspaces: Pick<WorkspaceRegistry, "get">;
  logger: Pick<Logger, "info">;
}

/**
 * Decides one attention event's delivery: a push, an in-app notification for one
 * recipient, or nothing. Reads the workspace mute, then the reply rules, at call time.
 */
export async function decideNotificationDelivery<R>(
  sources: NotificationPolicySources,
  event: {
    target: AttentionTarget;
    workspaceId: string | undefined;
    recipients: ReadonlyArray<{ recipient: R; state: ClientPresenceState }>;
    nowMs: number;
  },
): Promise<{ push: boolean; inAppRecipient: R | null }> {
  const { target } = event;
  const workspace = event.workspaceId ? await sources.workspaces.get(event.workspaceId) : null;
  const workspaceEnabled = workspace?.notifications !== "off";
  const muted =
    !workspaceEnabled || (target.kind === "agent" && suppressedByReplyRules(sources, target));
  const plan = computeNotificationPlan({
    allStates: event.recipients.map((entry) => entry.state),
    focusTarget:
      target.kind === "agent"
        ? { kind: "agent", id: target.agentId }
        : { kind: "terminal", id: target.terminalId },
    pushEligible: target.kind === "agent" ? isPushEligibleAttentionReason(target.reason) : true,
    nowMs: event.nowMs,
  });
  if (muted) return { push: false, inAppRecipient: null };
  return {
    push: plan.shouldPush,
    inAppRecipient:
      plan.inAppRecipientIndex === null
        ? null
        : (event.recipients[plan.inAppRecipientIndex]?.recipient ?? null),
  };
}

// Reply rules filter finished turns only. A subject the rules cannot judge fails open:
// the notification goes out and the reason is logged.
function suppressedByReplyRules(
  sources: NotificationPolicySources,
  target: Extract<AttentionTarget, { kind: "agent" }>,
): boolean {
  if (target.reason !== "finished") return false;
  const replyRules = sources.daemonConfig.getReplyRules();
  if (replyRules.length === 0) return false;
  const subject = target.completionSubject;
  const failOpenReason = classifyReplySubject(subject);
  if (failOpenReason) {
    sources.logger.info(
      {
        event: "reply_rule_match_fail_open",
        reason: failOpenReason,
        ruleCount: replyRules.length,
        ...(subject ? { subjectLength: subject.text.length } : {}),
      },
      "Reply-rule evaluation failed open",
    );
    return false;
  }
  return sources.daemonConfig.matchesReplyRules(subject);
}
