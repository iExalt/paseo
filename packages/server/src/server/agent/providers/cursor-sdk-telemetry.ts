import type { SDKMessage, TokenUsage } from "@cursor/sdk";
import type { AgentUsage, ToolCallDetail, ToolCallTimelineItem } from "../agent-sdk-types.js";

export function addCursorUsage(first: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!first) return next;
  const reasoningReported =
    first.reasoningTokens !== undefined || next.reasoningTokens !== undefined;
  return {
    inputTokens: first.inputTokens + next.inputTokens,
    cacheReadTokens: first.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + next.cacheWriteTokens,
    outputTokens: first.outputTokens + next.outputTokens,
    totalTokens: first.totalTokens + next.totalTokens,
    ...(reasoningReported
      ? { reasoningTokens: (first.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
      : {}),
  };
}

export function mapCursorUsage(usage: TokenUsage | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    totalTokens: usage.totalTokens,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type CursorTool = Extract<SDKMessage, { type: "tool_call" }>;

// Bump when the projection changes. Replay re-projects only unstamped or older
// rows: their raw payload may have been truncated for the journal, so a current
// row's stored detail (built from the full payload) is better than a rebuild.
const PROJECTION = 2;

// The untouched Cursor payload behind a row. Typed rows keep it in metadata so
// projection can rerun on journal replay and recovery can compare raw rows.
interface CursorRawTool {
  name: string;
  input: unknown;
  output: unknown;
  truncated: unknown;
}

function rawCursorTool(item: ToolCallTimelineItem): CursorRawTool | undefined {
  const meta = record(item.metadata?.cursorSdk);
  const name = string(meta?.name) ?? item.name;
  if (meta && "input" in meta && "output" in meta) {
    return { name, input: meta.input, output: meta.output, truncated: meta.truncated };
  }
  if (item.detail.type !== "unknown") return;
  return { name, input: item.detail.input, output: item.detail.output, truncated: meta?.truncated };
}

// Local Cursor runs report every finished call as "completed" and put
// failures in the result envelope.
function resultError(name: string, output: unknown): string | undefined {
  const envelope = record(output);
  if (envelope?.status !== "error") return;
  const error = envelope.error;
  const message = (
    typeof error === "string"
      ? error
      : (string(record(error)?.message) ?? string(record(error)?.error))
  )?.trim();
  // Cursor reports some failures, such as a missing file, only as "error".
  if (!message || message.toLowerCase() === "error") {
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} failed.`;
  }
  return message;
}

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

function lastAssistantText(steps: unknown): string | undefined {
  if (!Array.isArray(steps)) return;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const text = string(record(record(steps[index])?.assistantMessage)?.text)?.trim();
    if (text) return text;
  }
}

// Cursor's subagent IDs and transcripts belong to Cursor; they cannot be
// offered as navigable Paseo child sessions, so the card carries the answer.
function taskDetail(
  args: Record<string, unknown>,
  value: Record<string, unknown> | undefined,
): ToolCallDetail {
  const kind = record(args.subagentType);
  const named = string(kind?.name)?.trim() || string(kind?.kind)?.trim();
  // Steps can end without an assistant message; then the card has no answer.
  const log = string(value?.resultSuffix)?.trim() || lastAssistantText(value?.conversationSteps);
  return {
    type: "sub_agent",
    ...(named && named !== "unspecified" ? { subAgentType: named } : {}),
    ...(string(args.description) ? { description: string(args.description) } : {}),
    // COMPAT(subagent-log): apps before v0.14.1 require `log`.
    log: log ?? "",
  };
}

function toolDetail(
  name: string,
  args: Record<string, unknown>,
  value: Record<string, unknown> | undefined,
): ToolCallDetail | undefined {
  if (name === "shell" && typeof args.command === "string") {
    const exitCode = value?.exitCode;
    return {
      type: "shell",
      command: args.command,
      cwd: string(args.workingDirectory),
      ...(value
        ? {
            output: [string(value.stdout), string(value.stderr)].filter(Boolean).join("\n"),
            exitCode: typeof exitCode === "number" ? exitCode : undefined,
          }
        : {}),
    };
  }
  if (name === "task") return taskDetail(args, value);
  if (name === "grep" || name === "glob") {
    const query = string(name === "grep" ? args.pattern : args.globPattern);
    return query ? { type: "search", query, toolName: name } : undefined;
  }
  return fileToolDetail(name, args, value);
}

function mcpText(result: Record<string, unknown> | undefined): string | undefined {
  const content: unknown[] = Array.isArray(result?.content) ? result.content : [];
  // Like Codex, show an image as a placeholder instead of shipping its base64.
  const text = content
    .map((item) =>
      record(item)?.image ? "[image]" : string(record(record(item)?.text)?.text)?.trim(),
    )
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function mcpFailure(
  item: ToolCallTimelineItem,
  output: unknown,
  result: Record<string, unknown> | undefined,
): string | undefined {
  if (item.status !== "completed") return;
  const error = resultError("mcp", output);
  if (error || result?.isError !== true) return error;
  return mcpText(result) || "MCP tool returned an error.";
}

// Show MCP calls as Codex does: the tool's own arguments and result, not
// Cursor's envelopes. Paseo tool presentation reads fields at the top level.
function projectMcp(item: ToolCallTimelineItem, raw: CursorRawTool): ToolCallTimelineItem {
  const args = record(raw.input);
  const providerIdentifier = string(args?.providerIdentifier)?.trim();
  const toolName = string(args?.toolName)?.trim();
  const envelope = record(raw.output);
  const result = envelope?.status === "success" ? record(envelope.value) : undefined;
  const output = result ? (mcpText(result) ?? result.content ?? null) : null;
  const failed = mcpFailure(item, raw.output, result);
  const projected: ToolCallTimelineItem = {
    ...item,
    name: toolName ? `${providerIdentifier || "mcp"}.${toolName}` : item.name,
    detail: { type: "unknown", input: args?.args ?? args ?? null, output },
    metadata: {
      ...item.metadata,
      cursorSdk: {
        name: "mcp",
        projection: PROJECTION,
        toolName,
        input: raw.input,
        output: raw.output,
        ...(raw.truncated ? { truncated: raw.truncated } : {}),
      },
    },
  };
  return failed ? { ...projected, status: "failed", error: failed } : projected;
}

// Apply the current projection to rows saved by older daemons.
export function projectCursorTool(item: ToolCallTimelineItem): ToolCallTimelineItem {
  return record(item.metadata?.cursorSdk)?.projection === PROJECTION ? item : project(item);
}

function project(item: ToolCallTimelineItem): ToolCallTimelineItem {
  const raw = rawCursorTool(item);
  if (!raw) return item;
  if (raw.name === "mcp") return projectMcp(item, raw);
  const args = record(raw.input);
  const envelope = record(raw.output);
  const value = envelope?.status === "success" ? record(envelope.value) : undefined;
  // Keep payloads that are neither pending nor a result envelope inspectable as raw JSON.
  const recognized = raw.output == null || value !== undefined || envelope?.status === "error";
  const detail = args && recognized ? toolDetail(raw.name, args, value) : undefined;
  const failed = item.status === "completed" ? resultError(raw.name, raw.output) : undefined;
  // Unknown rows already carry the payload as their detail; typed rows keep it here.
  const cursorSdk: Record<string, unknown> = {
    ...(raw.truncated ? { truncated: raw.truncated } : {}),
    ...(detail ? { projection: PROJECTION, input: raw.input, output: raw.output } : {}),
  };
  const metadata: Record<string, unknown> = { ...item.metadata, cursorSdk };
  if (Object.keys(cursorSdk).length === 0) delete metadata.cursorSdk;
  const projected: ToolCallTimelineItem = {
    ...item,
    detail: detail ?? { type: "unknown", input: raw.input, output: raw.output },
  };
  if (Object.keys(metadata).length > 0) projected.metadata = metadata;
  else delete projected.metadata;
  return failed ? { ...projected, status: "failed", error: failed } : projected;
}

function cursorToolInput(message: CursorTool, previousInput: unknown): unknown {
  if (message.args === undefined) return previousInput ?? null;
  const args = record(message.args);
  if (
    (message.name === "mcp" || message.name === "grep" || message.name === "glob") &&
    args &&
    Object.keys(args).length === 0
  ) {
    return previousInput ?? args;
  }
  return message.args;
}

export function mapCursorTool(
  message: CursorTool,
  previous?: ToolCallTimelineItem,
): ToolCallTimelineItem {
  const prior = previous ? rawCursorTool(previous) : undefined;
  const input = cursorToolInput(message, prior?.input);
  const output = message.result !== undefined ? message.result : (prior?.output ?? null);
  const truncated = message.truncated ?? prior?.truncated;
  const base = {
    type: "tool_call" as const,
    callId: `${message.run_id}:${message.call_id}`,
    name: message.name,
    detail: { type: "unknown" as const, input, output },
    ...(truncated ? { metadata: { cursorSdk: { truncated } } } : {}),
  };
  if (message.status === "error") {
    return project({ ...base, status: "failed", error: output ?? "Cursor tool failed." });
  }
  return project({ ...base, status: message.status, error: null });
}
