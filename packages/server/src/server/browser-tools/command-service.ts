import { randomUUID } from "node:crypto";
import type {
  BrowserAutomationCommand,
  BrowserAutomationExecutePayload,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { normalizeBrowserHttpUrlInput } from "@getpaseo/protocol/browser-automation/url";
import type { BrowserToolsBroker } from "./broker.js";
import { browserToolsFailure } from "./errors.js";

export interface ExecuteBrowserCommandParams {
  broker: Pick<BrowserToolsBroker, "execute">;
  command: BrowserAutomationCommand;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  signal?: AbortSignal;
  requestId?: string;
  timeoutMs?: number;
}

const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";

export function normalizeBrowserCommandUrl(
  command: BrowserAutomationCommand,
): BrowserAutomationCommand | null {
  if (command.command === "new_tab") {
    if (!command.args.url) return command;
    const url = normalizeBrowserHttpUrlInput(command.args.url);
    return url ? { command: "new_tab", args: { ...command.args, url } } : null;
  }
  if (command.command === "navigate") {
    const url = normalizeBrowserHttpUrlInput(command.args.url);
    return url ? { command: "navigate", args: { ...command.args, url } } : null;
  }
  return command;
}

export async function executeBrowserCommand({
  broker,
  command,
  agentId,
  cwd,
  workspaceId,
  signal,
  requestId = randomUUID(),
  timeoutMs,
}: ExecuteBrowserCommandParams): Promise<BrowserAutomationExecutePayload> {
  const normalizedCommand = normalizeBrowserCommandUrl(command);
  if (!normalizedCommand) {
    return browserToolsFailure({
      requestId,
      code: "browser_denied",
      message: "URL must use http/https only",
    });
  }
  if (
    (normalizedCommand.command === "list_tabs" || normalizedCommand.command === "new_tab") &&
    !workspaceId
  ) {
    return browserToolsFailure({
      requestId,
      code: "browser_denied",
      message: WORKSPACE_CONTEXT_MESSAGE,
    });
  }
  const brokerTimeoutMs =
    timeoutMs ??
    (normalizedCommand.command === "wait" && normalizedCommand.args.timeoutMs !== undefined
      ? normalizedCommand.args.timeoutMs + 1_000
      : undefined);
  return broker.execute({
    agentId,
    cwd,
    workspaceId,
    command: normalizedCommand,
    requestId,
    ...(brokerTimeoutMs !== undefined ? { timeoutMs: brokerTimeoutMs } : {}),
    signal,
  });
}
