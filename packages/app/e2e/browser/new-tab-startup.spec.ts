import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { seedWorkspace } from "../support/helpers/seed-client";

test("a workspace with an existing agent never presents New during startup", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-tab-startup-agent-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Existing startup agent",
    modeId: "load-test",
    model: "ten-second-stream",
    initialPrompt: "ready",
  });

  try {
    await page.addInitScript(() => {
      Reflect.set(globalThis, "__paseoSawVisibleNewTab", false);
      function recordVisibleNewTab() {
        const panel = document.querySelector('[data-testid="workspace-new-tab-panel"]');
        if (panel?.getClientRects().length) {
          Reflect.set(globalThis, "__paseoSawVisibleNewTab", true);
        }
      }
      window.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(recordVisibleNewTab).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        recordVisibleNewTab();
      });
    });

    await gotoWorkspace(page, workspace.workspaceId);
    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("workspace-new-tab-panel").filter({ visible: true })).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => Reflect.get(globalThis, "__paseoSawVisibleNewTab"))).toBe(
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("a fresh browser preserves a workspace URL while its first host registers", async ({
  browser,
  baseURL,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "first-host-startup-" });
  const context = await browser.newContext();
  try {
    await context.route(/:(6767)\b/, (route) => route.abort());
    await context.routeWebSocket(/:(6767)\b/, async (ws) => {
      await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
    });
    await context.addInitScript((listen) => {
      Reflect.set(globalThis, "__PASEO_INITIAL_DAEMON_CONNECTION__", { listen });
    }, `127.0.0.1:${getE2EDaemonPort()}`);
    const page = await context.newPage();
    const destination = new URL(
      buildHostWorkspaceRoute(getServerId(), workspace.workspaceId),
      baseURL,
    ).href;
    await page.goto(destination);
    await expect(
      page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(destination);
    await page.reload();
    await expect(
      page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(destination);
  } finally {
    await context.close();
    await workspace.cleanup();
  }
});
