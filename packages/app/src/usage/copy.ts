import type { TFunction } from "i18next";
import type { UsageProblem } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { formatAgo } from "./format";

// Messages for usage failures outside the UI. Rendered copy uses useTranslation.
export const usageCopy = {
  problem: (problem: UsageProblem, now: Date = new Date(), t: TFunction = i18n.t): string => {
    if (problem.kind === "no_quota") return problem.detail;
    const remedy = problem.refreshedBy
      ? t("providerUsage.runToRefresh", { command: problem.refreshedBy })
      : t("providerUsage.signInAgain");
    if (problem.kind === "rejected")
      return t("providerUsage.loginRejected", { status: problem.status, remedy });
    return t("providerUsage.loginExpired", {
      relativeTime: formatAgo(problem.expiresAt, now.getTime(), t),
      remedy,
    });
  },
  get clientUnavailable() {
    return i18n.t("providerUsage.clientUnavailable");
  },
  hostUnavailable: (host: string) => i18n.t("providerUsage.hostUnavailable", { host }),
  // API spend copy is English-only until it moves into the locale resources.
  spend: "API spend",
  spendInfo:
    "What agents spent through this host, as each provider reports it. Plans billed by subscription may report a cost they don't charge.",
  spendToday: "Today",
  spendLast7Days: "7 days",
  spendThisMonth: "This month",
  spendAllTime: "All time",
  spendEmpty: "No spend recorded yet",
  spendLoading: "Loading spend...",
  spendErrorTitle: "Unable to load spend",
  spendHostUnavailable: (host: string) => `Connect to ${host} to see API spend`,
  spendUpgradeRequired: (host: string) => `Update ${host} to see API spend`,
  spendTrackingSince: (date: string) => `Tracked since ${date}.`,
  spendCarried: (amount: string) =>
    `Includes ${amount} from sessions that started before tracking, counted on the day they first reported it.`,
} as const;
