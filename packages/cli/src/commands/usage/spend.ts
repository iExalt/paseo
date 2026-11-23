import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SpendSummary } from "@getpaseo/protocol/messages";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import type { CommandOptions, OutputSchema } from "../../output/index.js";

interface SpendOptions extends CommandOptions {
  timeZone?: string;
  agent?: string;
  refresh?: boolean;
}
type SpendClient = Pick<DaemonClient, "getLastServerInfoMessage" | "getSpendSummary" | "close">;

export const spendSchema: OutputSchema<SpendSummary> = {
  idField: () => "spend",
  columns: [],
  renderHuman: (result) => {
    if (result.type !== "single") return "";
    const summary = result.data;
    const since =
      summary.trackingSince === null
        ? "No spend recorded"
        : `Tracking since ${summary.trackingSince}`;
    const period = (usd: number, unknown = 0) => {
      const amount = `$${usd.toFixed(2)}`;
      return unknown
        ? `${amount} known + ${unknown} ${unknown === 1 ? "run" : "runs"} with unknown cost`
        : amount;
    };
    const rows = [
      ...(summary.totals ? [{ provider: "Host", ...summary.totals }] : []),
      ...summary.providers,
    ].map(
      (provider) =>
        `${provider.provider}: today ${period(provider.todayUsd, provider.unknownCostRuns?.today)} | 7 days ${period(provider.last7DaysUsd, provider.unknownCostRuns?.last7Days)} | month ${period(provider.thisMonthUsd, provider.unknownCostRuns?.thisMonth)} | all time ${period(provider.allTimeUsd, provider.unknownCostRuns?.allTime)} (includes $${provider.carriedUsd.toFixed(2)} carried)`,
    );
    return ["API spend recorded by this host (USD)", since, ...rows].join("\n");
  },
};

export async function runSpendCommand(
  options: SpendOptions,
  _command: Command,
  connect: (options: ConnectOptions) => Promise<SpendClient> = connectToDaemon,
) {
  if (options.agent !== undefined || options.refresh !== undefined) {
    throw { code: "INVALID_OPTIONS", message: "usage spend does not accept --agent or --refresh." };
  }
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw { code: "INVALID_TIME_ZONE", message: "--time-zone must be a valid IANA time zone." };
  }
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.usageSpendSummary !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to view spend summaries." };
    }
    const { summary } = await client.getSpendSummary({ timeZone });
    return { type: "single" as const, data: summary, schema: spendSchema };
  } finally {
    await client.close();
  }
}
