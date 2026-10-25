import { describe, expect, it } from "vitest";
import {
  buildAgentAttentionNotificationPayload,
  findLatestAssistantMessageFromTimeline,
  findLatestPermissionRequest,
} from "./agent-attention-notification.js";

describe("buildAgentAttentionNotificationPayload", () => {
  it("carries the workspace needed to open a cold agent destination", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });

    expect(payload.data).toEqual({
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reason: "finished",
    });
  });

  it("builds finished notifications from markdown assistant text", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      assistantMessage: "**Done**. Updated `README.md` and [link](https://example.com).",
    });

    expect(payload).toEqual({
      title: "Agent finished",
      body: "Done. Updated README.md and link.",
      data: {
        serverId: "srv-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        reason: "finished",
      },
    });
  });

  it("builds permission notifications from request details", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "srv-2",
      workspaceId: "workspace-2",
      agentId: "agent-2",
      permissionRequest: {
        id: "perm-1",
        provider: "claude",
        name: "exec",
        kind: "tool",
        title: "**Approve command**",
        description: "Run `git push`",
      },
    });

    expect(payload).toEqual({
      title: "❓️ Agent needs permission",
      body: "Approve command - Run git push",
      data: {
        serverId: "srv-2",
        workspaceId: "workspace-2",
        agentId: "agent-2",
        reason: "permission",
      },
    });
  });

  it("uses error-specific defaults when reason is error", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "error",
      serverId: "srv-3",
      workspaceId: "workspace-3",
      agentId: "agent-3",
    });

    expect(payload).toEqual({
      title: "❗️ Agent needs attention",
      body: "Encountered an error.",
      data: {
        serverId: "srv-3",
        workspaceId: "workspace-3",
        agentId: "agent-3",
        reason: "error",
      },
    });
  });

  it.each([
    ["finished", "Fix login redirect"],
    ["permission", "❓️ Fix login redirect"],
    ["error", "❗️ Fix login redirect"],
  ] as const)("titles %s notifications with the thread title", (reason, title) => {
    const payload = buildAgentAttentionNotificationPayload({
      reason,
      serverId: "srv-4",
      workspaceId: "workspace-4",
      agentId: "agent-4",
      agentTitle: "  Fix login\nredirect ",
    });

    expect(payload.title).toBe(title);
  });

  it("ignores the placeholder thread title", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-5",
      workspaceId: "workspace-5",
      agentId: "agent-5",
      agentTitle: "New agent",
    });

    expect(payload.title).toBe("Agent finished");
  });
});

describe("findLatestAssistantMessageFromTimeline", () => {
  it("joins the latest contiguous assistant chunks", () => {
    expect(
      findLatestAssistantMessageFromTimeline([
        { type: "user_message", text: "start" },
        { type: "assistant_message", text: "Part " },
        { type: "assistant_message", text: "one" },
        { type: "reasoning", text: "thinking..." },
        { type: "assistant_message", text: "Done " },
        { type: "assistant_message", text: "now" },
      ]),
    ).toBe("Done now");
  });
});

describe("findLatestPermissionRequest", () => {
  it("returns the most recently inserted request", () => {
    const pending = new Map([
      ["first", { id: "first", provider: "claude", name: "a", kind: "tool" } as const],
      ["second", { id: "second", provider: "claude", name: "b", kind: "tool" } as const],
    ]);

    expect(findLatestPermissionRequest(pending)?.id).toBe("second");
  });
});
