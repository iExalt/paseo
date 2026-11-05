import type { Command } from "commander";
import type { WorkspaceSettingsPatch } from "@getpaseo/protocol/messages";
import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
} from "@getpaseo/protocol/workspace-labels";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface WorkspaceUpdateResult {
  workspaceId: string;
  notifications: "on" | "off";
  background?: boolean;
  title?: string | null;
  pinnedAt?: string | null;
  labels?: string[];
}

const workspaceUpdateSchema: OutputSchema<WorkspaceUpdateResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "NOTIFICATIONS", field: "notifications", width: 13 },
  ],
};

export interface WorkspaceUpdateOptions extends CommandOptions {
  notifications?: "on" | "off";
  background?: boolean;
  title?: string;
  resetTitle?: boolean;
  pin?: boolean;
  unpin?: boolean;
  addLabel?: string[];
  removeLabel?: string[];
}

export async function runUpdateCommand(
  workspaceId: string,
  options: WorkspaceUpdateOptions,
  command: Command,
): Promise<SingleResult<WorkspaceUpdateResult>> {
  validateOptions(options, command);
  const patch = resolvePatch(options);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // Keep the established notification-only operation available on older hosts.
    if (Object.keys(patch).length === 1 && patch.notifications !== undefined) {
      const applied = await client.setWorkspaceNotifications(workspaceId, patch.notifications);
      return {
        type: "single",
        data: { workspaceId, notifications: applied.notifications },
        schema: workspaceUpdateSchema,
      };
    }
    const applied = await client.updateWorkspaceSettings(workspaceId, patch);
    return {
      type: "single",
      data: { workspaceId, ...applied },
      schema: {
        ...workspaceUpdateSchema,
        columns: [
          { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
          { header: "TITLE", field: "title", width: 24 },
          { header: "BACKGROUND", field: "background", width: 10 },
          { header: "NOTIFICATIONS", field: "notifications", width: 13 },
          { header: "PINNED", field: (row) => (row.pinnedAt ? "yes" : "no"), width: 6 },
          { header: "LABELS", field: (row) => row.labels?.join(", ") ?? "", width: 24 },
        ],
      },
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_UPDATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function invalidOptions(message: string): never {
  throw { code: "INVALID_OPTIONS", message } satisfies CommandError;
}

function validateOptions(options: WorkspaceUpdateOptions, command: Command): void {
  let root = command;
  while (root.parent) root = root.parent;
  // Commander exposes rawArgs at runtime but omits it from its public types.
  const raw = (root as Command & { rawArgs?: string[] }).rawArgs ?? [];
  const flags = new Set(raw.slice(0, raw.indexOf("--") < 0 ? raw.length : raw.indexOf("--")));
  if (flags.has("--background") && flags.has("--no-background"))
    invalidOptions("Choose --background or --no-background");
  if (options.title !== undefined && options.resetTitle)
    invalidOptions("Choose --title or --reset-title");
  if (options.pin && options.unpin) invalidOptions("Choose --pin or --unpin");
  if (options.title !== undefined && options.title.trim().length === 0)
    invalidOptions("Title cannot be empty; use --reset-title");
}

function resolvePatch(options: WorkspaceUpdateOptions): WorkspaceSettingsPatch {
  const addLabels = options.addLabel?.map(normalizeWorkspaceLabelName);
  const removeLabels = options.removeLabel?.map(normalizeWorkspaceLabelName);
  if ([...(addLabels ?? []), ...(removeLabels ?? [])].some((name) => !name))
    invalidOptions("Label name cannot be empty");
  const removed = new Set(removeLabels?.map(workspaceLabelKey));
  if (addLabels?.some((name) => removed.has(workspaceLabelKey(name))))
    invalidOptions("Cannot add and remove the same label");
  const patch: WorkspaceSettingsPatch = {};
  if (options.background !== undefined) patch.background = options.background;
  if (options.title !== undefined) patch.title = options.title.trim();
  if (options.resetTitle) patch.title = null;
  if (options.notifications !== undefined) patch.notifications = options.notifications;
  if (options.pin || options.unpin) patch.pinned = options.pin === true;
  if (addLabels !== undefined) patch.addLabels = addLabels;
  if (removeLabels !== undefined) patch.removeLabels = removeLabels;
  if (!Object.keys(patch).length) invalidOptions("At least one workspace setting is required");
  return patch;
}
