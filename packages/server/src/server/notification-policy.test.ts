import { describe, expect, it, vi } from "vitest";
import type { ClientPresenceState } from "./agent-attention-policy.js";
import type { CompletionSubject } from "./agent/completion-subject.js";
import { ReplyRuleMatcher, type ReplyRule } from "./agent/reply-rule-matcher.js";
import {
  decideNotificationDelivery,
  type AttentionTarget,
  type NotificationPolicySources,
} from "./notification-policy.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";

const NOW = 1_000_000;
const NO_NEWS: ReplyRule = { source: "^No news\\.$", flags: "i" };
const subject = (text: string, completeness: CompletionSubject["completeness"] = "complete") => ({
  turnId: "turn-1",
  text,
  completeness,
});
const finished = (completionSubject?: CompletionSubject): AttentionTarget => ({
  kind: "agent",
  agentId: "agent-1",
  reason: "finished",
  ...(completionSubject ? { completionSubject } : {}),
});
// Present and looking elsewhere: gets the in-app notification, so no push.
const elsewhere: ClientPresenceState = {
  appVisible: true,
  lastActivityAtMs: NOW,
  focusedAgentId: null,
  focusedTerminalId: null,
};

function workspace(notifications: "on" | "off"): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: "project-1",
    cwd: "/tmp/project",
    kind: "directory",
    displayName: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    notifications,
  });
}

/** Daemon config and workspace registry in memory, read the way the daemon reads them. */
function createSources(options: { rules?: ReplyRule[]; notifications?: "on" | "off" } = {}) {
  const state = {
    rules: options.rules ?? [],
    workspace: workspace(options.notifications ?? "on") as PersistedWorkspaceRecord | null,
  };
  const matchesReplyRules = vi.fn((candidate: CompletionSubject) =>
    ReplyRuleMatcher.compile(state.rules).matches(candidate),
  );
  const info = vi.fn();
  const sources = {
    daemonConfig: { getReplyRules: () => state.rules, matchesReplyRules },
    workspaces: { get: vi.fn(async (_workspaceId: string) => state.workspace) },
    logger: { info },
  } satisfies NotificationPolicySources;
  return { state, sources, matchesReplyRules, info };
}

function decide(
  sources: NotificationPolicySources,
  target: AttentionTarget,
  options: { workspaceId?: string; present?: boolean } = {},
) {
  return decideNotificationDelivery(sources, {
    target,
    workspaceId: "workspaceId" in options ? options.workspaceId : "ws-1",
    recipients: options.present === false ? [] : [{ recipient: "client", state: elsewhere }],
    nowMs: NOW,
  });
}

describe("decideNotificationDelivery", () => {
  it("notifies in app when someone is present and pushes when nobody is", async () => {
    const { sources } = createSources();
    await expect(decide(sources, finished())).resolves.toEqual({
      push: false,
      inAppRecipient: "client",
    });
    await expect(decide(sources, finished(), { present: false })).resolves.toEqual({
      push: true,
      inAppRecipient: null,
    });
  });

  it("notifies in app the recipient the presence plan picks, not the first one", async () => {
    const { sources } = createSources();
    const delivery = await decideNotificationDelivery(sources, {
      target: finished(),
      workspaceId: "ws-1",
      recipients: [
        { recipient: "earlier", state: { ...elsewhere, lastActivityAtMs: NOW - 5_000 } },
        { recipient: "latest", state: elsewhere },
      ],
      nowMs: NOW,
    });
    expect(delivery).toEqual({ push: false, inAppRecipient: "latest" });
  });

  it("silences a finished turn whose complete reply matches a rule, in app and as a push", async () => {
    const { sources } = createSources({ rules: [NO_NEWS] });
    const silent = { push: false, inAppRecipient: null };
    await expect(decide(sources, finished(subject("No news.")))).resolves.toEqual(silent);
    await expect(
      decide(sources, finished(subject("No news.")), { present: false }),
    ).resolves.toEqual(silent);
    await expect(decide(sources, finished(subject("Shipped it.")))).resolves.toEqual({
      push: false,
      inAppRecipient: "client",
    });
  });

  it.each(["permission", "error"] as const)(
    "does not consult reply rules for %s",
    async (reason) => {
      const { sources, matchesReplyRules } = createSources({
        rules: [{ source: ".*", flags: "" }],
      });
      const target: AttentionTarget = {
        kind: "agent",
        agentId: "agent-1",
        reason,
        completionSubject: subject("anything"),
      };
      await expect(decide(sources, target)).resolves.toEqual({
        push: false,
        inAppRecipient: "client",
      });
      expect(matchesReplyRules).not.toHaveBeenCalled();
    },
  );

  it("fails open on a subject the rules cannot judge, logging its shape without its text", async () => {
    const { sources, info } = createSources({ rules: [NO_NEWS] });
    await expect(
      decide(sources, finished(subject("No news.", "incomplete")), { present: false }),
    ).resolves.toEqual({ push: true, inAppRecipient: null });
    await decide(sources, finished(), { present: false });
    expect(info.mock.calls).toEqual([
      [
        {
          event: "reply_rule_match_fail_open",
          reason: "incomplete_subject",
          ruleCount: 1,
          subjectLength: 8,
        },
        "Reply-rule evaluation failed open",
      ],
      [
        { event: "reply_rule_match_fail_open", reason: "missing_subject", ruleCount: 1 },
        "Reply-rule evaluation failed open",
      ],
    ]);
  });

  it("leaves rules unread and unlogged for a muted workspace or an empty rule set", async () => {
    const muted = createSources({ rules: [NO_NEWS], notifications: "off" });
    await expect(decide(muted.sources, finished(), { present: false })).resolves.toEqual({
      push: false,
      inAppRecipient: null,
    });
    expect(muted.matchesReplyRules).not.toHaveBeenCalled();
    expect(muted.info).not.toHaveBeenCalled();

    const noRules = createSources();
    await decide(noRules.sources, finished());
    expect(noRules.info).not.toHaveBeenCalled();
  });

  it("reads the rules after the workspace lookup settles", async () => {
    const { state, sources } = createSources();
    let settle: (record: PersistedWorkspaceRecord) => void = () => undefined;
    sources.workspaces.get.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const decision = decide(sources, finished(subject("No news.")));
    state.rules = [NO_NEWS];
    settle(workspace("on"));
    await expect(decision).resolves.toEqual({ push: false, inAppRecipient: null });
  });

  it("mutes terminals by workspace and treats a terminal without one as unmuted", async () => {
    const terminal: AttentionTarget = { kind: "terminal", terminalId: "term-1" };
    const muted = createSources({ notifications: "off" });
    await expect(decide(muted.sources, terminal, { present: false })).resolves.toEqual({
      push: false,
      inAppRecipient: null,
    });

    const unowned = createSources({ notifications: "off" });
    await expect(
      decide(unowned.sources, terminal, { workspaceId: undefined, present: false }),
    ).resolves.toEqual({ push: true, inAppRecipient: null });
    expect(unowned.sources.workspaces.get).not.toHaveBeenCalled();
  });
});
