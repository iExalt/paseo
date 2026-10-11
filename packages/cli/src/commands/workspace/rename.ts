import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceRenameResult {
  success: boolean;
  workspaceId: string;
  /** Raw title override; null once it has been reset to the derived name. */
  title: string | null;
}

const workspaceRenameSchema: OutputSchema<WorkspaceRenameResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "TITLE", field: "title", width: 30 },
  ],
};

export interface WorkspaceRenameOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  reset?: boolean;
  current?: boolean;
}

/**
 * Resolve the title to send to the daemon. Null clears the override and
 * reverts the workspace to its branch- or directory-derived name.
 */
export function resolveWorkspaceTitle(input: { title?: string; reset?: boolean }): string | null {
  const title = input.title?.trim() ?? "";
  if (input.reset) {
    if (input.title !== undefined) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--reset cannot be combined with a title",
        details: "Pass a title to rename the workspace, or --reset to revert to the derived name",
      } satisfies CommandError;
    }
    return null;
  }
  if (title.length === 0) {
    throw {
      code: "MISSING_TITLE",
      message: "Title cannot be empty",
      details: "Usage: paseo workspace rename <workspace-id> <title> | --reset",
    } satisfies CommandError;
  }
  return title;
}

export async function runRenameCommand(
  workspaceId: string | undefined,
  titleArg: string | undefined,
  options: WorkspaceRenameOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRenameResult>> {
  const targetWorkspaceId = options.current ? undefined : workspaceId;
  const titleInput = options.current ? (titleArg ?? workspaceId) : titleArg;
  if (options.current && titleArg !== undefined) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--current accepts a title without a workspace ID",
    } satisfies CommandError;
  }
  if (!options.current && !targetWorkspaceId) {
    throw {
      code: "MISSING_WORKSPACE_ID",
      message: "Workspace ID is required unless --current is selected",
    } satisfies CommandError;
  }
  const title = resolveWorkspaceTitle({ title: titleInput, reset: options.reset });

  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  });
  try {
    let resolvedWorkspaceId = targetWorkspaceId;
    const applied = options.current
      ? await (async () => {
          const callerAgentId = await resolveCallerAgentId(client);
          if (!callerAgentId) {
            throw {
              code: "MISSING_CALLER_AGENT",
              message: "--current requires a same-daemon PASEO_AGENT_ID",
            } satisfies CommandError;
          }
          const result = await client.setCurrentWorkspaceTitle(callerAgentId, title);
          resolvedWorkspaceId = result.workspaceId;
          return result;
        })()
      : await client.setWorkspaceTitle(targetWorkspaceId!, title);
    return {
      type: "single",
      data: { success: true, workspaceId: resolvedWorkspaceId!, title: applied.title },
      schema: workspaceRenameSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_RENAME_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
