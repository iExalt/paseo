import { expect, it } from "vitest";
import type { ToolCallItem } from "@/types/stream";
import { presentPaseoSend } from "./paseo-send";
function call(command: string): ToolCallItem {
  return {
    kind: "tool_call",
    id: "send",
    timestamp: new Date(),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "send",
        name: "exec_command",
        status: "completed",
        error: null,
        detail: { type: "shell", command, output: "sent" },
      },
    },
  };
}
it.each([
  '"$PASEO_CLI" agent send --no-wait --notify-on-finish worker "Hello"',
  "paseo agent send worker --prompt 'Hello'",
  "'/bin/paseo' agent send --no-wait worker 'Hello'",
])("presents a literal send using the existing message card: %s", (command) => {
  expect(presentPaseoSend(call(command))).toMatchObject({
    payload: {
      data: {
        name: "mcp__paseo__send_agent_prompt",
        detail: {
          type: "unknown",
          input: { agentId: "worker", prompt: "Hello", command },
          output: "sent",
        },
      },
    },
  });
});
it.each([
  "paseo\nagent send worker Hello",
  "'$PASEO_CLI' agent send worker Hello",
  "$BIN/paseo agent send worker Hello",
  "$(pwd)/paseo agent send worker Hello",
  "paseo agent send worker Hello*",
  "paseo agent send worker ~",
  "paseo agent send worker {Hello,world}",
  "paseo agent send worker #Hello",
  "/tmp/{1..3}/paseo agent send worker Hello",
  "echo paseo agent send worker Hello",
  "paseo agent send worker Hello && echo done",
  'paseo agent send worker "$(cat secret)"',
  'paseo agent send worker "$BODY"',
  "paseo agent send worker Hello > output",
])("preserves ambiguous shell commands: %s", (command) => {
  const item = call(command);
  expect(presentPaseoSend(item)).toBe(item);
});

it("preserves literal backslashes inside double quotes and quoted multiline messages", () => {
  for (const prompt of [String.raw`C:\tmp`, "Hello\nworld"]) {
    expect(presentPaseoSend(call(`paseo agent send worker "${prompt}"`))).toMatchObject({
      payload: { data: { detail: { input: { prompt } } } },
    });
  }
});
