import type { SDKMessage, TokenUsage } from "@cursor/sdk";
import type {
  AgentTimelineItem,
  AgentUsage,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  computerUseDetail,
  cursorTodos,
  deleteDetail,
  editFallback,
  globDetail,
  grepDetail,
  lsDetail,
  planDetail,
  readLintsDetail,
  recordScreenDetail,
  semSearchDetail,
  todosDetail,
} from "./cursor-sdk-tool-details.js";
import {
  renderProviderImagePathAsAssistantMarkdown,
  type ProviderImageOutput,
} from "./provider-image-output.js";

export interface CursorContextWindowReading {
  usedTokens?: number;
  maxTokens?: number;
}

/**
 * In Cursor SDK (`model-call-completed` and `turn-ended`), `inputTokens`
 * already includes `cacheReadTokens` and `cacheWriteTokens`, so a single LLM
 * call's context occupancy is `inputTokens + outputTokens`.
 */
export function cursorContextWindowUsedTokens(
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens"> | undefined,
): number | undefined {
  if (!usage) return undefined;
  const { inputTokens, outputTokens } = usage;
  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }
  const used = inputTokens + outputTokens;
  return used > 0 ? used : undefined;
}

export function withCursorContextUsage(
  usage: AgentUsage | undefined,
  context: CursorContextWindowReading,
): AgentUsage | undefined {
  const { usedTokens, maxTokens } = context;
  if (!usage && usedTokens === undefined) return undefined;
  return {
    ...usage,
    ...(usedTokens !== undefined ? { contextWindowUsedTokens: usedTokens } : {}),
    ...(maxTokens !== undefined ? { contextWindowMaxTokens: maxTokens } : {}),
  };
}

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

// Every projected row records the projection version of its tool. Replay
// re-projects only unstamped or older rows: their raw payload may have been
// truncated for the journal, so a current row's stored detail (built from the
// full payload) is better than a rebuild. When one tool's projection changes,
// give it an entry here with the next version so other tools' rows stay as
// written. A change that affects every tool bumps the default and every entry.
const DEFAULT_PROJECTION = 3;
const TOOL_PROJECTIONS: Readonly<Record<string, number>> = {};

function projectionOf(name: string): number {
  return TOOL_PROJECTIONS[name] ?? DEFAULT_PROJECTION;
}

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

function toolFailed(name: string): string {
  if (name === "mcp") return "MCP tool failed.";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} failed.`;
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
      : (string(record(error)?.message) ??
        string(record(error)?.error) ??
        string(record(envelope.value)?.message))
  )?.trim();
  // Cursor reports some failures, such as a missing file, only as "error".
  if (!message || message.toLowerCase() === "error") return toolFailed(name);
  return message;
}

// A failed call's error is shown as text; older rows stored the raw result.
function failureText(name: string, output: unknown): string {
  const text = string(output) ?? string(record(output)?.message);
  return resultError(name, output) ?? (text?.trim() || toolFailed(name));
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
        ? editFallback(args.path, args)
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

function shellDetail(
  args: Record<string, unknown>,
  value: Record<string, unknown> | undefined,
): ToolCallDetail | undefined {
  if (typeof args.command !== "string") return;
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

function toolDetail(
  name: string,
  args: Record<string, unknown>,
  value: Record<string, unknown> | undefined,
): ToolCallDetail | undefined {
  switch (name) {
    case "shell":
      return shellDetail(args, value);
    case "task":
      return taskDetail(args, value);
    case "grep":
      return grepDetail(args, value);
    case "glob":
      return globDetail(args, value);
    case "semSearch":
      return semSearchDetail(args, value);
    case "ls":
      return lsDetail(args, value);
    case "delete":
      return deleteDetail(args);
    case "readLints":
      return readLintsDetail(args, value);
    case "createPlan":
      return planDetail(args);
    case "updateTodos":
      return todosDetail(value);
    case "computerUse":
      return computerUseDetail(args, value);
    case "recordScreen":
      return recordScreenDetail(args, value);
    case "generateImage": {
      const description = string(args.description)?.trim();
      return {
        type: "plain_text",
        icon: "sparkles",
        ...(description ? { label: description, text: description } : {}),
      };
    }
    default:
      return fileToolDetail(name, args, value);
  }
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
        projection: projectionOf("mcp"),
        toolName,
        input: raw.input,
        output: raw.output,
        ...(raw.truncated ? { truncated: raw.truncated } : {}),
      },
    },
  };
  return failed ? { ...projected, status: "failed", error: failed } : projected;
}

// Cursor reports a nonzero exit as a successful call carrying the exit code.
// Claude and Codex mark such commands failed, even where the exit is expected,
// as with grep finding nothing.
function shellExitFailure(item: ToolCallTimelineItem): ToolCallTimelineItem {
  if (item.status !== "completed" || item.detail.type !== "shell") return item;
  const { exitCode } = item.detail;
  if (typeof exitCode !== "number" || exitCode === 0) return item;
  return { ...item, status: "failed", error: `Command exited with code ${exitCode}.` };
}

// Rules that read only the row and its short error, so they also fix stamped
// rows without rebuilding them from a possibly truncated payload.
function settle(item: ToolCallTimelineItem, raw: CursorRawTool): ToolCallTimelineItem {
  if (item.status === "failed" && typeof item.error !== "string") {
    return { ...item, error: failureText(raw.name, raw.output) };
  }
  return shellExitFailure(item);
}

// Replay a journaled row. Current rows were projected and expanded when they
// were written; rows from older daemons get the current projection and the
// items it adds, such as a task list or a generated image.
export function replayCursorTool(item: ToolCallTimelineItem): AgentTimelineItem[] {
  const raw = rawCursorTool(item);
  if (!raw) return [item];
  return record(item.metadata?.cursorSdk)?.projection === projectionOf(raw.name)
    ? [settle(item, raw)]
    : cursorTimelineItems(project(item));
}

function project(item: ToolCallTimelineItem): ToolCallTimelineItem {
  const raw = rawCursorTool(item);
  if (!raw) return item;
  return settle(raw.name === "mcp" ? projectMcp(item, raw) : projectTool(item, raw), raw);
}

function projectTool(item: ToolCallTimelineItem, raw: CursorRawTool): ToolCallTimelineItem {
  const args = record(raw.input);
  const envelope = record(raw.output);
  const value = envelope?.status === "success" ? record(envelope.value) : undefined;
  // Keep payloads that are neither pending nor a result envelope inspectable as raw JSON.
  const recognized = raw.output == null || value !== undefined || envelope?.status === "error";
  const detail = args && recognized ? toolDetail(raw.name, args, value) : undefined;
  const failed = item.status === "completed" ? resultError(raw.name, raw.output) : undefined;
  // Unknown rows already carry the payload as their detail; typed rows keep it here.
  const cursorSdk: Record<string, unknown> = {
    projection: projectionOf(raw.name),
    ...(raw.truncated ? { truncated: raw.truncated } : {}),
    ...(detail ? { input: raw.input, output: raw.output } : {}),
  };
  const projected: ToolCallTimelineItem = {
    ...item,
    detail: detail ?? { type: "unknown", input: raw.input, output: raw.output },
    metadata: { ...item.metadata, cursorSdk },
  };
  return failed ? { ...projected, status: "failed", error: failed } : projected;
}

// Show a generated image inline after its row, as Codex does. The result
// carries the saved file's absolute path; the SDK drops the image bytes.
function generatedImageItems(item: ToolCallTimelineItem, raw: CursorRawTool): AgentTimelineItem[] {
  const envelope = record(raw.output);
  const value = envelope?.status === "success" ? record(envelope.value) : undefined;
  const image =
    item.status === "completed"
      ? renderProviderImagePathAsAssistantMarkdown({
          path: string(value?.filePath),
          // Prompts run long and can hold blank lines, which would break the image
          // paragraph; the row above already shows the prompt.
          altText: "Generated image",
        })
      : null;
  return image ? [item, image] : [item];
}

// Show the screenshot a computer-use call took after its row. Cursor returns its
// path on success and on failure, where it shows the screen the action left.
function screenshotItems(item: ToolCallTimelineItem, raw: CursorRawTool): AgentTimelineItem[] {
  const envelope = record(raw.output);
  const fields = record(envelope?.status === "success" ? envelope.value : envelope?.error);
  const image =
    item.status === "completed" || item.status === "failed"
      ? renderProviderImagePathAsAssistantMarkdown({
          path: string(fields?.screenshotPath),
          altText: "Screenshot",
        })
      : null;
  return image ? [item, image] : [item];
}

// MCP image content to show inline after its row. Only live rows have it:
// the journal truncates the base64 data.
export function cursorMcpImages(item: AgentTimelineItem): ProviderImageOutput[] {
  if (item.type !== "tool_call" || item.status !== "completed") return [];
  const raw = record(item.metadata?.cursorSdk);
  const envelope = record(raw?.output);
  if (raw?.name !== "mcp" || envelope?.status !== "success") return [];
  const content: unknown[] = Array.isArray(record(envelope.value)?.content)
    ? (record(envelope.value)?.content as unknown[])
    : [];
  return content.flatMap((entry) => {
    const image = record(record(entry)?.image);
    const data = string(image?.data);
    return data ? [{ data, mimeType: string(image?.mimeType) ?? null }] : [];
  });
}

// Claude and Codex show todo updates as a task list, not a tool row. A
// completed updateTodos call becomes that list; a running one shows nothing
// yet; a failed, canceled or listless one stays a row.
export function cursorTimelineItems(item: ToolCallTimelineItem): AgentTimelineItem[] {
  const raw = rawCursorTool(item);
  if (raw?.name === "generateImage") return generatedImageItems(item, raw);
  if (raw?.name === "computerUse") return screenshotItems(item, raw);
  if (raw?.name !== "updateTodos") return [item];
  if (item.status === "running") return [];
  const envelope = record(raw.output);
  const todos =
    item.status === "completed" && envelope?.status === "success"
      ? cursorTodos(record(envelope.value))
      : undefined;
  return todos ? [{ type: "todo", items: todos }] : [item];
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
    return project({ ...base, status: "failed", error: failureText(message.name, output) });
  }
  return project({ ...base, status: message.status, error: null });
}
