import type { SDKMessage } from "@cursor/sdk";
import type { ToolCallDetail, ToolCallTimelineItem } from "../agent-sdk-types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type CursorTool = Extract<SDKMessage, { type: "tool_call" }>;

function fileToolDetail(
  name: string,
  args: Record<string, unknown>,
  value: Record<string, unknown> | undefined,
): ToolCallDetail | undefined {
  if (typeof args.path !== "string") return;
  switch (name) {
    case "read":
      return { type: "read", filePath: args.path, content: string(value?.content) };
    case "write":
      return {
        type: "write",
        filePath: args.path,
        content: string(value?.fileContentAfterWrite) ?? string(args.fileText),
      };
    case "edit": {
      const unifiedDiff = string(value?.diffString) ?? string(args.patchContent);
      return unifiedDiff === undefined
        ? undefined
        : { type: "edit", filePath: args.path, unifiedDiff };
    }
  }
}

function toolDetail(name: string, input: unknown, output: unknown): ToolCallDetail {
  const args = record(input);
  const result = record(output);
  const value = result?.status === "success" ? record(result.value) : undefined;
  // Keep unrecognized and error payloads inspectable in the generic details view.
  if (args && (output == null || value)) {
    if (name === "shell" && typeof args.command === "string") {
      const exitCode = value?.exitCode;
      const stdout = string(value?.stdout);
      const stderr = string(value?.stderr);
      return {
        type: "shell",
        command: args.command,
        cwd: string(args.workingDirectory),
        ...(value
          ? {
              output: [stdout, stderr].filter(Boolean).join("\n"),
              exitCode: typeof exitCode === "number" ? exitCode : undefined,
            }
          : {}),
      };
    }

    const file = fileToolDetail(name, args, value);
    if (file) return file;

    // The native task's agent ID and transcript path belong to Cursor. They
    // cannot be offered as navigable Paseo child sessions.
    if (name === "task" && value?.resultSuffix && typeof value.resultSuffix === "string") {
      return {
        type: "sub_agent",
        description: string(args.description),
        log: value.resultSuffix,
      };
    }
  }
  return { type: "unknown", input, output };
}

export function mapCursorTool(
  message: CursorTool,
  previous?: ToolCallTimelineItem,
): ToolCallTimelineItem {
  const prior =
    previous?.detail.type === "unknown" ? previous.detail : record(previous?.metadata?.cursorSdk);
  const input = message.args !== undefined ? message.args : (prior?.input ?? null);
  const output = message.result !== undefined ? message.result : (prior?.output ?? null);
  const truncated = message.truncated ?? record(previous?.metadata?.cursorSdk)?.truncated;
  const detail = toolDetail(message.name, input, output);
  const base = {
    type: "tool_call" as const,
    callId: `${message.run_id}:${message.call_id}`,
    name: message.name,
    detail,
    ...(detail.type !== "unknown" || truncated
      ? { metadata: { cursorSdk: { input, output, truncated } } }
      : {}),
  };
  if (message.status === "error") {
    return { ...base, status: "failed", error: output ?? "Cursor tool failed." };
  }
  return { ...base, status: message.status, error: null };
}
