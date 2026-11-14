import type { WorkspaceSetupSnapshot } from "@getpaseo/protocol/messages";
import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceSetupResult {
  workspaceId: string;
  status: "started" | "already_allowed" | WorkspaceSetupSnapshot["status"] | "none";
  snapshot?: WorkspaceSetupSnapshot | null;
}

const workspaceSetupSchema: OutputSchema<WorkspaceSetupResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 18 },
  ],
};

export async function runSetupCommand(
  workspaceId: string,
  options: {
    status?: boolean;
    host?: string;
    daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  },
  _command: Command,
): Promise<SingleResult<WorkspaceSetupResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (options.status) {
      const { snapshot } = await client.fetchWorkspaceSetupStatus(workspaceId);
      return {
        type: "single",
        data: { workspaceId, status: snapshot?.status ?? "none", snapshot },
        schema: workspaceSetupSchema,
      };
    }
    // COMPAT(workspaceSetupRun): added in v0.7.3, remove gate after 2027-09-02.
    if (!client.getLastServerInfoMessage()?.features?.workspaceSetupRun) {
      throw { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host to run workspace setup." };
    }
    const payload = await client.runWorkspaceSetup(workspaceId);
    if (payload.error) throw new Error(payload.error);
    return {
      type: "single",
      data: { workspaceId, status: payload.started ? "started" : "already_allowed" },
      schema: workspaceSetupSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_SETUP_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
