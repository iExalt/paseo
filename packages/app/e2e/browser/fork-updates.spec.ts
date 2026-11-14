import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import { installForkUpdateFixture } from "../support/helpers/fork-update-bridge";
async function countStableChecks(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const calls = (
      window as unknown as {
        forkUpdateFixtureCalls: Array<{ command: string; args?: { releaseChannel?: string } }>;
      }
    ).forkUpdateFixtureCalls;
    return calls.filter(
      (call) => call.command === "check_app_update" && call.args?.releaseChannel === "stable",
    ).length;
  });
}

for (const mode of [
  "windows",
  "macos-nix",
  "linux-nix",
  "linux-bootstrap",
  "nix-invalid",
  "browser",
] as const) {
  test(`About uses fork updates for ${mode}`, async ({ page }, testInfo) => {
    await installForkUpdateFixture(page, mode);
    await gotoAppShell(page);
    if (mode === "windows") {
      const callout = page.getByTestId("update-callout");
      await callout.getByRole("button", { name: "Install & restart", exact: true }).click();
      await expect(callout).toContainText("waiting for active agents");
      await expect(callout.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
      await callout.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(callout).toContainText("waiting for active agents");
      await callout.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(callout).toHaveCount(0);
    }
    await openSettings(page);
    await openSettingsSection(page, "about");
    await expect(page.getByText("App version", { exact: true })).toBeVisible();
    if (mode === "browser") {
      await expect(page.getByText("Fork updates", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("Fork updates", { exact: true })).toBeVisible();
      if (mode === "windows") {
        const row = page.getByTestId("desktop-fork-update-row");
        await expect(
          row.getByRole("button", { name: "Update to v0.23.2", exact: true }),
        ).toBeEnabled();
        await row.getByRole("button", { name: "Check", exact: true }).click();
        await expect.poll(() => countStableChecks(page)).toBeGreaterThan(0);
        page.once("dialog", (dialog) => dialog.dismiss());
        await row.getByRole("button", { name: "Update to v0.23.2", exact: true }).click();
        page.once("dialog", (dialog) => dialog.accept());
        await row.getByRole("button", { name: "Update to v0.23.2", exact: true }).click();
        await expect(row).toContainText("waiting for active agents");
      } else if (mode === "linux-bootstrap") {
        await expect(page.getByTestId("nix-desktop-update-status")).toContainText(
          "require one bootstrap",
        );
        await expect(
          page
            .getByTestId("nix-desktop-update-row")
            .getByRole("button", { name: "Check", exact: true }),
        ).toBeEnabled();
      } else if (mode === "nix-invalid") {
        await expect(page.getByTestId("nix-desktop-update-status")).toContainText(
          "could not be verified",
        );
      }
    }
    await expect(page.getByText("Release channel", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Beta", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${mode}-about.png`) });
  });
}
