import type { Command } from "commander";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import type { CommandOptions, OutputSchema } from "../../output/index.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
type RefreshProvidersSnapshotPayload = Awaited<
  ReturnType<DaemonClient["refreshProvidersSnapshot"]>
>;

const schema: OutputSchema<RefreshProvidersSnapshotPayload> = {
  idField: () => "providers",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};

export async function runRefreshCommand(
  provider: string | undefined,
  options: CommandOptions & { cwd?: string },
  _command: Command,
  connect: (
    options: ConnectOptions,
  ) => Promise<
    Pick<DaemonClient, "getLastServerInfoMessage" | "refreshProvidersSnapshot" | "close">
  > = connectToDaemon,
) {
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.providersSnapshot !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to refresh providers." };
    }
    const data = await client.refreshProvidersSnapshot({
      cwd: options.cwd,
      providers: provider === undefined ? undefined : [provider.trim().toLowerCase()],
    });
    return { type: "single" as const, data, schema };
  } finally {
    await client.close();
  }
}
