import { remoteConfigEdit } from "../daemon/config.js";
import { runSpendCommand } from "./spend.js";
import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type CommandResult } from "../../output/index.js";
import { usageSchema } from "./presentation.js";

interface UsageOptions extends CommandOptions {
  agent?: string;
  refresh?: boolean;
}

type UsageSelection = { kind: "list" } | { kind: "inspect"; id: string };
interface UsageClient {
  getLastServerInfoMessage(): { features?: { usageSources?: boolean } } | null;
  listUsageReports: DaemonClient["listUsageReports"];
  fetchAgent: DaemonClient["fetchAgent"];
  close: DaemonClient["close"];
}
type ConnectUsage = (options: ConnectOptions) => Promise<UsageClient>;

export async function runUsageCommand(
  options: UsageOptions,
  selection: UsageSelection,
  connect: ConnectUsage = connectToDaemon,
): Promise<CommandResult<UsageReportEntry>> {
  const conflictingSelectors = selection.kind === "inspect" && options.agent !== undefined;
  if (conflictingSelectors) {
    throw {
      code: "INVALID_OPTIONS",
      message:
        "--agent cannot be combined with usage inspect. Use usage ls --agent <id> for agent account usage, or usage inspect <report-id> for an exact report.",
    };
  }
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.usageSources !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to use usage reports." };
    }
    if (selection.kind === "list") {
      const { reports } = await client.listUsageReports({
        agentId:
          options.agent === undefined ? undefined : await resolveAgentTarget(client, options.agent),
        forceRefresh: options.refresh,
      });
      return { type: "list", data: reports, schema: usageSchema };
    }
    // Report-ID queries only select known accounts. Discover before selecting, including on cold hosts.
    const { reports } = await client.listUsageReports();
    let entry = reports.find((report) => report.id === selection.id);
    if (entry && options.refresh) {
      const refreshed = await client.listUsageReports({
        reportIds: [selection.id],
        forceRefresh: true,
      });
      entry = refreshed.reports.find((report) => report.id === selection.id);
    }
    if (!entry) {
      throw { code: "REPORT_NOT_FOUND", message: `Unknown usage report: ${selection.id}` };
    }
    return { type: "single", data: entry, schema: usageSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

function addListOptions(command: Command): Command {
  return addJsonAndDaemonHostOptions(command)
    .option(
      "--agent <id>",
      "Show account quota associated with this agent, by ID, prefix, or full session ID (not agent token consumption)",
    )
    .option("--refresh", "Refresh usage instead of using the host cache");
}

export function createUsageCommand(): Command {
  const usage = addListOptions(new Command("usage").description("Show account usage reports"));
  for (const [verb, enabled] of [
    ["on", true],
    ["off", false],
  ] as const)
    addJsonAndDaemonHostOptions(
      usage.command(verb).description(`Turn usage reporting ${verb}`),
    ).action(
      withOutput((options: CommandOptions, _command: Command) =>
        remoteConfigEdit("usage.enabled", { value: enabled }, options),
      ),
    );
  const list = (options: CommandOptions, _command: Command) =>
    runUsageCommand(options, { kind: "list" });
  usage.action(withOutput(list));
  addListOptions(usage.command("ls").description("List account quotas and balances")).action(
    withOutput(list),
  );
  addJsonAndDaemonHostOptions(
    usage
      .command("inspect")
      .description("Show a complete account usage report")
      .argument("<report-id>", "Exact opaque Report ID")
      .option("--refresh", "Refresh the selected report instead of using the host cache"),
  ).action(
    withOutput((id: string, options: CommandOptions, _command: Command) =>
      runUsageCommand(options, { kind: "inspect", id }),
    ),
  );
  addJsonAndDaemonHostOptions(
    usage
      .command("spend")
      .description("Show this host's recorded API spend")
      .option("--time-zone <iana>", "Time zone for daily and monthly spend (default: local)"),
  ).action(
    withOutput((options: CommandOptions, command: Command) => runSpendCommand(options, command)),
  );
  return usage;
}
