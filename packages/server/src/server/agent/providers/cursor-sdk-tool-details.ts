import type { AgentTaskItem, ToolCallDetail } from "../agent-sdk-types.js";

// Typed details for Cursor SDK tools beyond shell, read, edit and task. Shapes
// follow @cursor/sdk's vendor/cursor-sdk-shared/tool-call-types.d.ts.

type Fields = Record<string, unknown>;
type SearchDetail = Extract<ToolCallDetail, { type: "search" }>;

function record(value: unknown): Fields | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface GrepResults {
  lines: string[];
  files: Set<string>;
  matches: number;
  mode?: SearchDetail["mode"];
}

function addGrepContent(results: GrepResults, output: Fields | undefined): void {
  results.mode = "content";
  for (const match of list(output?.matches).map(record)) {
    const file = string(match?.file);
    if (!file) continue;
    const line = number(match?.lineNumber);
    const prefix = line === undefined ? `${file}:` : `${file}:${line}:`;
    results.files.add(file);
    results.lines.push(`${prefix}${string(match?.line) ?? ""}`);
  }
  results.matches += number(output?.totalMatches) ?? 0;
}

function addGrepCounts(results: GrepResults, output: Fields | undefined): void {
  results.mode = "count";
  for (const count of list(output?.counts).map(record)) {
    const file = string(count?.file);
    const matches = number(count?.count) ?? 0;
    if (!file) continue;
    results.files.add(file);
    results.lines.push(`${file}:${matches}`);
    results.matches += matches;
  }
}

function addGrepResult(results: GrepResults, result: Fields): void {
  const output = record(result.output);
  if (result.type === "content") addGrepContent(results, output);
  if (result.type === "count") addGrepCounts(results, output);
  if (result.type !== "files") return;
  results.mode = "files_with_matches";
  for (const file of list(output?.files)) if (typeof file === "string") results.files.add(file);
}

export function grepDetail(args: Fields, value: Fields | undefined): ToolCallDetail | undefined {
  const query = string(args.pattern);
  if (!query) return;
  if (!value) return { type: "search", query, toolName: "grep" };
  const results: GrepResults = { lines: [], files: new Set(), matches: 0 };
  const sources = [
    ...Object.values(record(value.workspaceResults) ?? {}),
    value.activeEditorResult,
  ];
  for (const result of sources.map(record)) if (result) addGrepResult(results, result);
  return {
    type: "search",
    query,
    toolName: "grep",
    ...(results.lines.length > 0 ? { content: results.lines.join("\n") } : {}),
    ...(results.mode === "files_with_matches" ? { filePaths: [...results.files] } : {}),
    numFiles: results.files.size,
    ...(results.mode === "files_with_matches" ? {} : { numMatches: results.matches }),
    ...(results.mode ? { mode: results.mode } : {}),
  };
}

export function globDetail(args: Fields, value: Fields | undefined): ToolCallDetail | undefined {
  const query = string(args.globPattern);
  if (!query) return;
  if (!value) return { type: "search", query, toolName: "glob" };
  const filePaths = list(value.files).filter((file): file is string => typeof file === "string");
  return {
    type: "search",
    query,
    toolName: "glob",
    filePaths,
    numFiles: number(value.totalFiles) ?? filePaths.length,
    ...(value.clientTruncated === true || value.ripgrepTruncated === true
      ? { truncated: true }
      : {}),
  };
}

export function semSearchDetail(
  args: Fields,
  value: Fields | undefined,
): ToolCallDetail | undefined {
  const query = string(args.query);
  if (!query) return;
  const content = string(value?.results)?.trim();
  return { type: "search", query, toolName: "search", ...(content ? { content } : {}) };
}

// Edits without a diff: string replacements carry the old and new text.
export function editFallback(filePath: string, args: Fields): ToolCallDetail {
  const edits = args.oldText !== undefined ? [args] : list(args.edits).map(record);
  const pairs = edits.flatMap((edit) => {
    const oldString = string(edit?.oldText);
    const newString = string(edit?.newText);
    return oldString === undefined || newString === undefined ? [] : [{ oldString, newString }];
  });
  if (pairs.length === 0) return { type: "edit", filePath };
  return {
    type: "edit",
    filePath,
    oldString: pairs.map((pair) => pair.oldString).join("\n…\n"),
    newString: pairs.map((pair) => pair.newString).join("\n…\n"),
  };
}

interface TreeNode {
  absPath?: unknown;
  childrenDirs?: unknown;
  childrenFiles?: unknown;
}

function treeLines(node: TreeNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  for (const dir of list(node.childrenDirs).map(record)) {
    if (!dir) continue;
    const path = string(dir.absPath) ?? "";
    out.push(`${indent}${path.slice(path.lastIndexOf("/") + 1)}/`);
    treeLines(dir, depth + 1, out);
  }
  for (const file of list(node.childrenFiles).map(record)) {
    const name = string(file?.name);
    if (name) out.push(`${indent}${name}`);
  }
}

export function lsDetail(args: Fields, value: Fields | undefined): ToolCallDetail | undefined {
  const path = string(args.path);
  if (!path) return;
  const root = record(value?.directoryTreeRoot);
  const lines: string[] = [];
  if (root) treeLines(root, 0, lines);
  return {
    type: "plain_text",
    label: path,
    icon: "search",
    ...(lines.length ? { text: lines.join("\n") } : {}),
  };
}

export function deleteDetail(args: Fields): ToolCallDetail | undefined {
  const path = string(args.path);
  return path ? { type: "plain_text", label: path, icon: "pencil" } : undefined;
}

function diagnosticLine(path: string, item: Fields): string {
  const start = record(record(item.range)?.start);
  const line = number(start?.line);
  const where =
    line === undefined ? path : `${path}:${line + 1}:${(number(start?.character) ?? 0) + 1}`;
  const source = [string(item.source), string(item.code)].filter(Boolean).join(" ");
  return `${where} ${string(item.severity) ?? "error"}: ${string(item.message) ?? ""}${source ? ` (${source})` : ""}`;
}

export function readLintsDetail(args: Fields, value: Fields | undefined): ToolCallDetail {
  const paths = list(args.paths).filter((path): path is string => typeof path === "string");
  const lines = list(value?.fileDiagnostics).flatMap((file) => {
    const fields = record(file);
    const path = string(fields?.path) ?? "";
    return list(fields?.diagnostics).flatMap((item) => {
      const diagnostic = record(item);
      return diagnostic ? [diagnosticLine(path, diagnostic)] : [];
    });
  });
  let text: string | undefined;
  if (value) text = lines.length > 0 ? lines.join("\n") : "No diagnostics.";
  return {
    type: "plain_text",
    ...(paths.length > 0 ? { label: paths.join(", ") } : {}),
    icon: "eye",
    ...(text ? { text } : {}),
  };
}

export function planDetail(args: Fields): ToolCallDetail | undefined {
  const text = string(args.plan);
  return text ? { type: "plan", text } : undefined;
}

const TODO_STATUS: Record<string, AgentTaskItem["status"]> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

// Cursor's result holds the full list; its arguments can be a delta. Paseo's
// task list has no cancelled state, so cancelled items drop out, as Claude's
// deleted items do.
export function cursorTodos(value: Fields | undefined): AgentTaskItem[] | undefined {
  if (!value || !Array.isArray(value.todos)) return;
  return value.todos.flatMap((todo) => {
    const fields = record(todo);
    const text = string(fields?.content)?.trim();
    const status = TODO_STATUS[string(fields?.status) ?? ""];
    if (!text || !status) return [];
    return [
      {
        text,
        completed: status === "completed",
        status,
        ...(string(fields?.id) ? { id: string(fields?.id) } : {}),
      },
    ];
  });
}

export function todosDetail(value: Fields | undefined): ToolCallDetail {
  const todos = cursorTodos(value) ?? [];
  const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
  const text = todos.map((todo) => `${mark[todo.status ?? "pending"]} ${todo.text}`).join("\n");
  return { type: "plain_text", label: "Update todos", icon: "wrench", ...(text ? { text } : {}) };
}
