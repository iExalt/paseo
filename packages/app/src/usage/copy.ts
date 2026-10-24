import type { UsageProblem } from "@getpaseo/protocol/messages";
import { formatCompactTimeAgo, formatCompactTimeAgoAsProse } from "@/utils/time";

// User-facing copy for the usage surfaces, kept in one file so localization is a
// single-file change.
export const usageCopy = {
  problem: (problem: UsageProblem, now: Date = new Date()): string => {
    if (problem.kind === "no_quota") return problem.detail;
    const remedy = problem.refreshedBy
      ? `Run ${problem.refreshedBy} to refresh it.`
      : "Sign in again.";
    if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
    const ago = formatCompactTimeAgoAsProse(formatCompactTimeAgo(new Date(problem.expiresAt), now));
    return `Login expired ${ago}. ${remedy}`;
  },
  title: "Usage",
  planUsage: "Plan usage",
  options: "Settings",
  refresh: "Refresh",
  refreshAll: "Refresh all",
  refreshing: "Refreshing...",
  refreshFailed: "Unable to refresh usage",
  updated: "Updated",
  loading: "Loading usage...",
  empty: "No usage data",
  noHosts: "No connected hosts",
  errorTitle: "Unable to load usage",
  agentError: (reason: string) => `Unable to load usage: ${reason}`,
  hostUnavailable: (host: string) => `Connect to ${host} to see usage`,
  hostUpgradeRequired: (host: string) => `Update ${host} to see usage`,
  clientUnavailable: "Host connection is not ready",
  retry: "Try again",
  pin: "Pin",
  unpin: "Unpin",
  displayAs: "Percentages",
  displayUsed: "Used",
  displayRemaining: "Remaining",
  showInSidebar: "Summary in sidebar",
  showInSidebarHint: "Pinned windows show in the sidebar footer",
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
