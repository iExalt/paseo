import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { qaScreenshot } from "../support/helpers/context-window";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import {
  installUsageReportsFixture,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import {
  openUsageFromIcon,
  refreshAllUsage,
  showUsageAs,
} from "../support/helpers/usage-sidebar-item";

const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';

function forcedRefreshCount(usage: UsageReportsFixture): number {
  return usage.listRequests().filter((request) => request.forceRefresh).length;
}

function report(input: {
  sourceId: string;
  sourceLabel: string;
  report:
    | Partial<Extract<UsageReportEntry["report"], { status: "available" }>>
    | Exclude<UsageReportEntry["report"], { status: "available" }>;
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:account`,
    account: { label: input.sourceId === "alpha" ? "dev@example.com" : undefined },
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    icon: ICON,
    report:
      input.report.status === "error" || input.report.status === "unavailable"
        ? input.report
        : {
            status: "available",
            windows: [],
            ...input.report,
          },
  };
}

test.describe("usage settings", () => {
  test("renders every report returned by usage.list_reports", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              planLabel: "Max",
              windows: [{ id: "session", label: "Session", usedPct: 7 }],
            },
          }),
          report({
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: {
              planLabel: "Coding plan",
              windows: [
                { id: "biweekly", label: "Biweekly", usedPct: 23 },
                { id: "daily", label: "Daily", remainingPct: 30 },
              ],
              balances: [
                { id: "credits", label: "Credits", remaining: 1234, unit: "credits" },
                { id: "extra", label: "Extra usage", used: 5, limit: 20, unit: "usd" },
              ],
              details: [{ id: "valid", label: "Valid until", value: "2026-12-31" }],
            },
          }),
          report({
            sourceId: "gamma",
            sourceLabel: "Gamma plan",
            report: { status: "error", error: "Gamma auth expired" },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    await usage.waitForListRequests(1);

    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("dev@example.com", { exact: true })).toBeVisible();
    await expect(card.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(card.getByText("70% used")).toBeVisible();
    await expect(card.getByText("1,234 left", { exact: true })).toBeVisible();
    await expect(card.getByText("$5.00 / $20.00", { exact: true })).toBeVisible();
    await expect(card.getByText("2026-12-31", { exact: true })).toBeVisible();
    await expect(card.getByText("Gamma auth expired", { exact: true })).toBeVisible();

    // The shared percentages setting applies to the host section.
    await expect(page.getByTestId("usage-options-menu")).toBeVisible();
    const hostUsageUrl = page.url();
    await gotoAppShell(page);
    await openUsageFromIcon(page);
    await showUsageAs(page, "remaining");
    await page.goto(hostUsageUrl);
    await expect(card.getByText("30% left")).toBeVisible();
    await expect(card.getByText("93% left")).toBeVisible();
  });

  test("refresh forces a fresh report", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const windows = (usedPct: number) => [{ id: "w", label: "Weekly", usedPct }];
    // The sidebar summary and the section each load reports; only Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) => [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { windows: windows(request.forceRefresh ? 64 : 23) },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("23% used")).toBeVisible({ timeout: 10_000 });

    await refreshAllUsage(page);
    await expect.poll(() => forcedRefreshCount(usage)).toBe(1);
    await expect(card.getByText("64% used")).toBeVisible();
  });

  test("asks to update a host without usage support and never calls it", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSupported: false });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    await expect(
      // Names the host: "Update Laptop to see usage".
      page.getByTestId("usage-card").getByText(/^Update (?!the host ).+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    expect(usage.listRequests()).toHaveLength(0);
  });
});

test.describe("api spend", () => {
  test("shows what agents spent by provider, as the daemon recorded it", async ({ page }) => {
    test.setTimeout(180_000);
    const serverId = getServerId();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "usage-spend-",
      title: "Usage spend e2e",
      initialPrompt: "emit 32000 byte file agent stream payload costing $1.25",
    });
    try {
      // Other specs share the daemon and spend too, so read the total the section should show.
      const allTimeUsd = async () =>
        (await agent.client.getSpendSummary()).summary.providers.find(
          (provider) => provider.provider === "mock",
        )?.allTimeUsd ?? 0;
      await expect.poll(allTimeUsd, { timeout: 30_000 }).toBeGreaterThanOrEqual(1.25);

      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHostSection(page, serverId, "usage");
      // A phone-width page shows whether the amounts fit side by side.
      await page.setViewportSize({ width: 390, height: 844 });
      const row = page.getByTestId("spend-card").getByTestId("spend-row-mock");
      await expect(async () => {
        const expected = new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(
          await allTimeUsd(),
        );
        await expect(row.getByLabel(`All time ${expected}`)).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await expect(row.getByText("Today", { exact: true })).toBeVisible();
      await expect(row.getByText("This month", { exact: true })).toBeVisible();
      await qaScreenshot(page, "usage-spend-compact");
      await page.setViewportSize({ width: 1440, height: 900 });
      await qaScreenshot(page, "usage-spend-desktop");
    } finally {
      await agent.cleanup();
    }
  });
});
