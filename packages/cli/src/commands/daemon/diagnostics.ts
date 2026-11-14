import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
type DiagnosticsPayload = Awaited<ReturnType<DaemonClient["collectDiagnostics"]>>;
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";

const schema: OutputSchema<DiagnosticsPayload> = {
  idField: () => "diagnostics",
  columns: [],
  renderHuman: (result) => (result.type === "single" ? result.data.diagnostic : ""),
};

export function daemonDiagnosticsCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("diagnostics").description("Collect daemon diagnostics"),
  ).action(
    withOutput((options: CommandOptions, command: Command) =>
      runDiagnosticsCommand(options, command),
    ),
  );
}

export async function runDiagnosticsCommand(
  options: CommandOptions,
  _command: Command,
  connect: (
    options: ConnectOptions,
  ) => Promise<
    Pick<DaemonClient, "getLastServerInfoMessage" | "collectDiagnostics" | "close">
  > = connectToDaemon,
) {
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.daemonDiagnostics !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to collect diagnostics." };
    }
    const data = await client.collectDiagnostics();
    return { type: "single" as const, data, schema };
  } finally {
    await client.close();
  }
}
