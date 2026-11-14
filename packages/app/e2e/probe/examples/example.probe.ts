// Copy to .dev/probes/<name>.probe.ts, change the import to
// "../../packages/app/e2e/probe/fixtures", and run `npm run probe -- <name>`.
import { expect, probe } from "../fixtures";

probe("a seeded agent's chat settles", async ({ page, qa }) => {
  const agent = qa.seed?.agents[0];
  if (!agent) throw new Error("qa:web started without a seed");
  // A fresh browser lands on /open-project from a deep link until it has saved the host.
  await page.goto("/");
  await page.goto(`/h/${qa.serverId}/agent/${agent.id}`);
  await expect(
    page.locator(`[data-testid="agent-timeline-settled"][data-agent-id="${agent.id}"]`),
  ).toBeAttached();
});

probe.describe("as the desktop app", () => {
  probe.use({ desktop: "local-daemon" });

  probe("settings list the desktop-only permissions section", async ({ page }) => {
    await page.goto("/");
    // The desktop app's startup redirect wins over a typed settings URL, so open them as a user would.
    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-section-permissions")).toBeVisible();
  });
});
