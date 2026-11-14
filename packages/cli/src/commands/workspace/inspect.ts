import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { SingleResult, CommandError } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRow } from "./shared.js";
import type { WorkspaceLsOptions } from "./ls.js";

export async function runInspectCommand(
  workspaceId: string,
  options: WorkspaceLsOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRow>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        filter: { includeBackground: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const workspace = payload.entries.find((entry) => entry.id === workspaceId);
      if (workspace)
        return { type: "single", data: toWorkspaceRow(workspace), schema: workspaceSchema };
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    throw {
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace not found: ${workspaceId}`,
    } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
