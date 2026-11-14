import type { Command } from "commander";
import type { WorkspaceRecoveryState } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
interface RecoveryResult {
  workspaceId: string;
  restored: boolean;
  state: WorkspaceRecoveryState | null;
}
const schema: OutputSchema<RecoveryResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 24 },
    { header: "RESTORED", field: "restored", width: 10 },
    { header: "RECOVERY", field: (row) => row.state?.kind ?? "restored", width: 20 },
  ],
};
export async function runRecoverCommand(
  workspaceId: string,
  options: { daemonTarget: DaemonTarget; inspect?: boolean },
  _command: Command,
): Promise<SingleResult<RecoveryResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(workspaceRecovery): added in v0.1.105, remove gate after 2027-01-11.
    if (!client.getLastServerInfoMessage()?.features?.workspaceRecovery)
      throw { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host to recover workspaces." };
    if (options.inspect) {
      const state = await client.inspectWorkspaceRecovery(workspaceId);
      return { type: "single", data: { workspaceId, restored: false, state }, schema };
    }
    await client.restoreWorkspace(workspaceId);
    return { type: "single", data: { workspaceId, restored: true, state: null }, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
