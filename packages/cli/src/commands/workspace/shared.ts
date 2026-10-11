import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export interface WorkspaceRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
  cwd: string;
  background: boolean;
  notifications: "on" | "off";
  workspace: {
    workspaceId: string;
    projectId: string;
    cwd: string;
    isolation: "local" | "worktree";
    kind: "directory" | "local_checkout" | "worktree";
    title: string | null;
    background?: boolean;
    notifications: "on" | "off";
  };
}

export const workspaceSchema: OutputSchema<WorkspaceRow> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "CWD", field: "cwd", width: 42 },
    { header: "NOTIFICATIONS", field: "notifications", width: 13 },
  ],
};

/** `--background` listings add a column so hidden workspaces stand out. */
export const workspaceWithBackgroundSchema: OutputSchema<WorkspaceRow> = {
  ...workspaceSchema,
  columns: [
    ...workspaceSchema.columns,
    { header: "BACKGROUND", field: (row) => (row.background ? "yes" : ""), width: 8 },
  ],
};

export function toWorkspaceRow(workspace: WorkspaceDescriptorPayload): WorkspaceRow {
  const isolation = workspace.workspaceKind === "worktree" ? "worktree" : "local";
  let kind: WorkspaceRow["workspace"]["kind"] = "directory";
  if (workspace.workspaceKind === "worktree") kind = "worktree";
  else if (workspace.workspaceKind === "local_checkout") kind = "local_checkout";
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation,
    cwd: workspace.workspaceDirectory,
    background: workspace.background === true,
    notifications: workspace.notifications ?? "on",
    workspace: {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      cwd: workspace.workspaceDirectory,
      isolation,
      kind,
      title: workspace.title ?? null,
      ...(workspace.background === undefined ? {} : { background: workspace.background }),
      notifications: workspace.notifications ?? "on",
    },
  };
}
