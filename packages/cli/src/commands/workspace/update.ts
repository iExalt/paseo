import type { Command } from "commander";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface WorkspaceUpdateResult {
  workspaceId: string;
  notifications: "on" | "off";
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
}

export async function runUpdateCommand(
  workspaceId: string,
  options: WorkspaceUpdateOptions,
): Promise<SingleResult<WorkspaceUpdateResult>> {
  try {
    return {
      type: "single",
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_UPDATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
