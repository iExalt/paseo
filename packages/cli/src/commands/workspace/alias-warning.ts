import { realpathSync } from "node:fs";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonTarget } from "../../utils/daemon-target.js";

interface ProjectLister {
  listProjects(): Promise<{ projects: WorkspaceProjectDescriptorPayload[] }>;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Paseo keeps each folder spelling as its own project (upstream #2098), so a cwd reached
 * through a symlink lands in a separate project from the same checkout's existing one.
 * After creating a workspace, warn once on stderr when its project shares a checkout with
 * another active project. Advisory only: failures stay silent, and so does a daemon on
 * another host, whose paths can't be resolved here.
 */
export async function warnAboutAliasedProject(input: {
  client: ProjectLister;
  daemonTarget: DaemonTarget | undefined;
  workspaceId: string;
  projectId: string;
  warn?: (message: string) => void;
}): Promise<void> {
  if (input.daemonTarget?.kind === "endpoint") return;
  const warn = input.warn ?? ((message: string) => console.error(message));
  try {
    const { projects } = await input.client.listProjects();
    const created = projects.find((project) => project.projectId === input.projectId);
    if (!created) return;
    const createdReal = realpathOrNull(created.projectRootPath);
    if (!createdReal) return;
    const twins = projects.filter(
      (other) =>
        other.projectId !== created.projectId &&
        other.projectRootPath !== created.projectRootPath &&
        realpathOrNull(other.projectRootPath) === createdReal,
    );
    if (twins.length === 0) return;
    const named = twins.map((twin) => `${twin.projectId} (${twin.projectRootPath})`).join(", ");
    warn(
      `Warning: workspace ${input.workspaceId} was created in project ${created.projectId} ` +
        `(${created.projectRootPath}), which is the same checkout as project ${named}. ` +
        `To use the existing project, archive this workspace and recreate it with ` +
        `\`workspace create --project ${twins[0]!.projectId}\`.`,
    );
  } catch {
    // Advisory only.
  }
}
