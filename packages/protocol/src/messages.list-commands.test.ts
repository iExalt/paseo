import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("list_commands_request schema", () => {
  test("accepts legacy agent-only payload", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_commands_request",
      agentId: "agent-123",
      requestId: "req-123",
    });

    expect(parsed.type).toBe("list_commands_request");
    if (parsed.type !== "list_commands_request") {
      throw new Error("Expected list_commands_request message");
    }
    expect(parsed.agentId).toBe("agent-123");
    expect(parsed.draftConfig).toBeUndefined();
  });

  test("accepts draft command context payload", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_commands_request",
      agentId: "__new_agent__",
      draftConfig: {
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "bypassPermissions",
        model: "gpt-5",
        thinkingOptionId: "off",
        featureValues: {
          plan_mode: true,
        },
      },
      requestId: "req-456",
    });

    expect(parsed.type).toBe("list_commands_request");
    if (parsed.type !== "list_commands_request") {
      throw new Error("Expected list_commands_request message");
    }
    expect(parsed.draftConfig).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "bypassPermissions",
      model: "gpt-5",
      thinkingOptionId: "off",
      featureValues: {
        plan_mode: true,
      },
    });
  });

  test("preserves command kind metadata in responses", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_commands_response",
      payload: {
        agentId: "agent-123",
        requestId: "req-123",
        error: null,
        commands: [
          {
            name: "taste",
            description: "Apply code taste",
            argumentHint: "",
            kind: "skill",
          },
        ],
      },
    });

    expect(parsed.type).toBe("list_commands_response");
    if (parsed.type !== "list_commands_response") {
      throw new Error("Expected list_commands_response message");
    }
    expect(parsed.payload.commands).toEqual([
      {
        name: "taste",
        description: "Apply code taste",
        argumentHint: "",
        kind: "skill",
      },
    ]);
  });

  test("falls back to command for unknown future command kinds", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_commands_response",
      payload: {
        agentId: "agent-123",
        requestId: "req-123",
        error: null,
        commands: [
          {
            name: "future-command",
            description: "Future command kind",
            argumentHint: "",
            kind: "future-kind",
          },
        ],
      },
    });

    expect(parsed.type).toBe("list_commands_response");
    if (parsed.type !== "list_commands_response") {
      throw new Error("Expected list_commands_response message");
    }
    expect(parsed.payload.commands[0]?.kind).toBe("command");
  });
});

test("keeps the selected Cursor skill reference distinct from a same-name command", () => {
  const skill = { name: "taste", scope: "workspace", id: "a".repeat(64), revision: "b".repeat(64) };
  const command = {
    name: "taste",
    description: "Run a command",
    argumentHint: "",
    kind: "command",
  };
  const selected = { ...command, description: "Run a selected skill", kind: "skill", skill };
  const reply = {
    type: "list_commands_response",
    payload: { agentId: "agent", requestId: "list", commands: [command, selected], error: null },
  };
  expect(SessionOutboundMessageSchema.parse(reply)).toEqual(reply);

  const send = {
    type: "send_agent_message_request",
    requestId: "send",
    agentId: "agent",
    text: "Keep my text.",
    attachments: [{ type: "cursor_skill", reference: skill }],
  };
  expect(SessionInboundMessageSchema.parse(send)).toEqual(send);
  expect(
    SessionInboundMessageSchema.safeParse({
      ...send,
      attachments: [{ type: "cursor_skill", reference: { ...skill, id: "/outside/SKILL.md" } }],
    }).success,
  ).toBe(false);
});
