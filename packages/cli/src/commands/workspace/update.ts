import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
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
  _command: Command,
): Promise<SingleResult<WorkspaceUpdateResult>> {
  if (options.notifications === undefined) {
    throw {
      code: "MISSING_NOTIFICATIONS_POLICY",
      message: "A notification policy is required",
      details: "Usage: paseo workspace update <workspace-id> --notifications <on|off>",
    } satisfies CommandError;
  }
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
    const applied = await client.setWorkspaceNotifications(workspaceId, options.notifications);
    return {
      type: "single",
      data: { workspaceId, notifications: applied.notifications },
      schema: workspaceUpdateSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_UPDATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
