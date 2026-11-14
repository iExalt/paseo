import { describe, expect, it } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import { createStub } from "../test-utils/class-mocks.js";
import { resolveNewAgentScheduleTarget } from "./caller-runtime.js";

const caller = {
  id: "caller-1",
  provider: "codex",
  cwd: "/workspace/project",
  config: {
    model: "gpt-5.4",
    thinkingOptionId: "high",
    providerOptions: { approvalPolicy: "never" },
    featureValues: { search: true },
    systemPrompt: "Use the project rules.",
    mcpServers: { review: { command: "review" } },
  },
  currentModeId: "plan",
};

function getCaller() {
  return createStub<AgentManager>({ getAgent: () => caller }).getAgent(caller.id);
}

describe("resolveNewAgentScheduleTarget", () => {
  it("inherits caller runtime config while applying explicit worktree and cwd options", () => {
    const target = resolveNewAgentScheduleTarget({
      callerAgent: getCaller(),
      overrides: { cwd: "~/child", isolation: "worktree" },
    });

    expect(target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: expect.stringMatching(/\/child$/),
        model: "gpt-5.4",
        modeId: "plan",
        thinkingOptionId: "high",
        isolation: "worktree",
        providerOptions: { approvalPolicy: "never" },
        featureValues: { search: true },
        systemPrompt: "Use the project rules.",
        mcpServers: { review: { command: "review" } },
      },
    });
  });

  it("does not carry provider-specific model, mode, or options across providers", () => {
    const target = resolveNewAgentScheduleTarget({
      callerAgent: getCaller(),
      overrides: { provider: "claude/sonnet", model: "sonnet", modeId: "plan" },
    });

    expect(target.config).toMatchObject({
      provider: "claude",
      model: "sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      featureValues: { search: true },
      systemPrompt: "Use the project rules.",
      mcpServers: { review: { command: "review" } },
    });
    expect(target.config).not.toHaveProperty("providerOptions");
  });

  it("requires and resolves a provider when there is no caller context", () => {
    expect(() => resolveNewAgentScheduleTarget({})).toThrow(
      "provider is required when target is new-agent",
    );
    expect(
      resolveNewAgentScheduleTarget({
        overrides: { provider: "claude/sonnet" },
        defaultCwd: "/repo",
      }),
    ).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/repo", model: "sonnet" },
    });
  });
});
