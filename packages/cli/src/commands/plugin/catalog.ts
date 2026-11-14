import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import type { CommandOptions, OutputSchema } from "../../output/index.js";
interface CatalogResult {
  plugins: Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>;
}
type CatalogClient = Pick<DaemonClient, "getLastServerInfoMessage" | "getPluginCatalog" | "close">;
const schema: OutputSchema<CatalogResult> = {
  idField: () => "catalog",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};
export async function runPluginCatalogCommand(
  options: CommandOptions,
  _command: Command,
  connect: (options: ConnectOptions) => Promise<CatalogClient> = connectToDaemon,
) {
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.plugins !== true)
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to list the plugin catalog." };
    const plugins = await client.getPluginCatalog();
    return { type: "single" as const, data: { plugins }, schema };
  } finally {
    await client.close();
  }
}
