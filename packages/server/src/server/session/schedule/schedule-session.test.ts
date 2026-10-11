import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { ScheduleSession } from "./schedule-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { ScheduleService } from "../../schedule/service.js";
import type { AgentManager } from "../../agent/agent-manager.js";

function makeSession(
  schedule: { [K in keyof ScheduleService]?: unknown },
  agents: { [K in keyof AgentManager]?: unknown } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new ScheduleSession({
    host: { emit: (message) => emitted.push(message) },
    scheduleService: createStub<ScheduleService>(schedule),
    agentManager: createStub<AgentManager>({ getAgent: () => null, ...agents }),
    logger: pino({ level: "silent" }),
  });
  return { session, emitted };
}

describe("ScheduleSession", () => {
  it("schedule/create returns a summary with the runs stripped", async () => {
    const stored = {
      id: "s1",
      name: null,
      prompt: "p",
      cadence: { type: "every" as const, everyMs: 1000 },
      target: { type: "agent" as const, agentId: "a" },
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [
        {
          id: "run-1",
          scheduledFor: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          status: "running" as const,
          agentId: null,
          output: null,
          error: null,
        },
      ],
    };
    const { session, emitted } = makeSession({ create: async () => stored });

    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "sc1",
      prompt: "p",
      cadence: { type: "every", everyMs: 1000 },
      target: { type: "agent", agentId: "a" },
    });

    const response = findByType(emitted, "schedule/create/response");
    expect(response?.payload.schedule).toBeDefined();
    expect(response?.payload.schedule).not.toHaveProperty("runs");
    expect(response?.payload.schedule.id).toBe("s1");
  });

  it("schedule/create remaps a self target to an agent target before creating", async () => {
    let received: Parameters<ScheduleService["create"]>[0] | undefined;
    const stored = {
      id: "s2",
      name: null,
      prompt: "p",
      cadence: { type: "every" as const, everyMs: 1000 },
      target: { type: "agent" as const, agentId: "agent-9" },
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    };
    const { session, emitted } = makeSession({
      create: async (input: Parameters<ScheduleService["create"]>[0]) => {
        received = input;
        return stored;
      },
    });

    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "sc2",
      prompt: "p",
      cadence: { type: "every", everyMs: 1000 },
      target: { type: "self", agentId: "agent-9" },
    });

    expect(received?.target).toEqual({ type: "agent", agentId: "agent-9" });
    expect(findByType(emitted, "schedule/create/response")?.payload.error).toBeNull();
  });

  it("derives caller runtime and expiry on the daemon before create", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const caller = {
      id: "00000000-0000-0000-0000-000000000001",
      provider: "codex",
      cwd: "/workspace/caller",
      config: {
        model: "gpt-5.4",
        thinkingOptionId: "high",
        featureValues: { search: true },
        systemPrompt: "caller prompt",
        mcpServers: { review: { command: "review" } },
        providerOptions: { approvalPolicy: "never" },
      },
      currentModeId: "plan",
    };
    let received: Parameters<ScheduleService["create"]>[0] | undefined;
    const schedule = {
      id: "s-context",
      name: null,
      prompt: "p",
      cadence: { type: "every" as const, everyMs: 1000 },
      target: {
        type: "new-agent" as const,
        config: {
          provider: "claude",
          cwd: "/workspace/override",
          model: "sonnet",
          modeId: "bypassPermissions",
          thinkingOptionId: "high",
          isolation: "worktree" as const,
          featureValues: { search: true },
          systemPrompt: "caller prompt",
          mcpServers: { review: { command: "review" } },
        },
      },
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: "2026-01-01T01:00:00.000Z",
      maxRuns: null,
      runs: [],
    };
    const { session, emitted } = makeSession(
      {
        create: async (input: Parameters<ScheduleService["create"]>[0]) => {
          received = input;
          return schedule;
        },
      },
      { getAgent: () => caller },
    );

    try {
      await session.handleScheduleCreateRequest({
        type: "schedule/create",
        requestId: "sc-context",
        prompt: "p",
        cadence: { type: "every", everyMs: 1000 },
        target: {
          type: "new-agent",
          config: { provider: "codex", cwd: "/fallback" },
        },
        callerContext: {
          agentId: caller.id,
          provider: "claude/sonnet",
          modeId: "bypassPermissions",
          isolation: "worktree",
        },
        expiresIn: "1h",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(received?.target).toMatchObject({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/workspace/caller",
        model: "sonnet",
        modeId: "bypassPermissions",
        thinkingOptionId: "high",
        isolation: "worktree",
        featureValues: { search: true },
        systemPrompt: "caller prompt",
        mcpServers: { review: { command: "review" } },
      },
    });
    expect(received?.expiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(findByType(emitted, "schedule/create/response")?.payload.error).toBeNull();
  });

  it("rejects unknown caller context before creating a schedule", async () => {
    const create = vi.fn();
    const { session, emitted } = makeSession({ create });

    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "sc-unknown-caller",
      prompt: "p",
      cadence: { type: "every", everyMs: 1000 },
      target: {
        type: "new-agent",
        config: { provider: "codex", cwd: "/fallback" },
      },
      callerContext: {
        agentId: "00000000-0000-0000-0000-000000000001",
      },
    });

    expect(create).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      type: "rpc_error",
      payload: { error: expect.stringContaining("Caller agent") },
    });
  });

  it("restricts marker-scoped heartbeat deletion to that exact agent", async () => {
    const deleteSchedule = vi.fn();
    const { session, emitted } = makeSession(
      {
        inspect: async () => ({
          target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000002" },
        }),
        delete: deleteSchedule,
      },
      {
        getAgent: () => ({ id: "00000000-0000-0000-0000-000000000001" }),
      },
    );

    await session.handleScheduleDeleteRequest({
      type: "schedule/delete",
      requestId: "sc-wrong-owner",
      scheduleId: "heartbeat-1",
      callerAgentId: "00000000-0000-0000-0000-000000000001",
    });

    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      type: "rpc_error",
      payload: { error: expect.stringContaining("does not belong") },
    });
  });

  it("rejects marker-scoped heartbeat updates for another agent", async () => {
    const updateSchedule = vi.fn();
    const { session, emitted } = makeSession(
      {
        inspect: async () => ({
          target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000002" },
        }),
        update: updateSchedule,
      },
      {
        getAgent: () => ({ id: "00000000-0000-0000-0000-000000000001" }),
      },
    );

    await session.handleScheduleUpdateRequest({
      type: "schedule/update",
      requestId: "sc-wrong-owner-update",
      scheduleId: "heartbeat-1",
      callerAgentId: "00000000-0000-0000-0000-000000000001",
      name: "must not change",
    });

    expect(updateSchedule).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      type: "rpc_error",
      payload: { error: expect.stringContaining("does not belong") },
    });
  });
});
