import { describe, expect, it } from "vitest";
import { ScheduleCreateRequestSchema, ScheduleUpdateRequestSchema } from "./rpc-schemas.js";

describe("schedule RPC schemas", () => {
  it("round-trips new-agent run options on create requests", () => {
    expect(
      ScheduleCreateRequestSchema.parse({
        type: "schedule/create",
        requestId: "request-1",
        prompt: "Run the task",
        cadence: { type: "every", everyMs: 60_000 },
        target: {
          type: "new-agent",
          config: {
            provider: "claude",
            cwd: "/tmp/project",
            thinkingOptionId: "think-hard",
            archiveOnFinish: false,
            isolation: "worktree",
          },
        },
      }),
    ).toEqual({
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: "/tmp/project",
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      },
    });
  });

  it("accepts optional parity context, daemon-relative expiry, and replacement fields", () => {
    const request = {
      type: "schedule/create" as const,
      requestId: "request-2",
      prompt: "Run the task",
      cadence: { type: "every" as const, everyMs: 60_000 },
      target: {
        type: "new-agent" as const,
        config: { provider: "claude", cwd: "/fallback" },
      },
      callerContext: {
        agentId: "00000000-0000-0000-0000-000000000001",
        provider: "codex/gpt-5.4",
        model: "gpt-5.4",
        isolation: "worktree" as const,
      },
      expiresIn: "1h",
      replaceExisting: true,
    };
    expect(ScheduleCreateRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips new-agent run options on update requests", () => {
    expect(
      ScheduleUpdateRequestSchema.parse({
        type: "schedule/update",
        requestId: "request-1",
        scheduleId: "schedule-1",
        newAgentConfig: {
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      }),
    ).toEqual({
      type: "schedule/update",
      requestId: "request-1",
      scheduleId: "schedule-1",
      newAgentConfig: {
        thinkingOptionId: "think-hard",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
  });

  it("accepts caller ownership and daemon-relative expiry on update requests", () => {
    const request = {
      type: "schedule/update" as const,
      requestId: "request-3",
      scheduleId: "heartbeat-1",
      callerAgentId: "00000000-0000-0000-0000-000000000001",
      newAgentConfig: { model: null, modeId: null },
      expiresIn: "2h",
    };
    expect(ScheduleUpdateRequestSchema.parse(request)).toEqual(request);
  });
});
