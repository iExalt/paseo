import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { seedWorkspace } from "../support/helpers/seed-client";

const ignoreCloseError = () => {};

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
  let releaseProbe = () => {};
  let probeStarted = false;
  let heldSocketClosed = false;
  let holdFirstProbe = true;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  try {
    await context.route(/:(6767)\b/, (route) => route.abort());
    await context.routeWebSocket(/:(6767)\b/, async (ws) => {
      await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
    });
    await context.routeWebSocket(daemonWsRoutePattern(), async (ws) => {
      if (holdFirstProbe) {
        let server: ReturnType<typeof ws.connectToServer> | undefined;
        ws.onClose(async (code, reason) => {
          heldSocketClosed = true;
          await server?.close({ code, reason }).catch(ignoreCloseError);
        });
        holdFirstProbe = false;
        probeStarted = true;
        await probeGate;
        if (!heldSocketClosed) server = ws.connectToServer();
        return;
      }
      ws.connectToServer();
    });
    await context.addInitScript((listen) => {
      Reflect.set(globalThis, "__PASEO_INITIAL_DAEMON_CONNECTION__", { listen });
    }, `127.0.0.1:${getE2EDaemonPort()}`);
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
    const destination = new URL(
      buildHostWorkspaceRoute(getServerId(), workspace.workspaceId),
      baseURL,
    ).href;
    await page.goto(destination);
    await expect.poll(() => probeStarted).toBe(true);
    await expect(page.getByTestId("startup-splash")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/h/${getServerId()}`));
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return (
          url.pathname.endsWith(`/workspace/${workspace.workspaceId}`) ||
          url.searchParams.get("workspaceId") === workspace.workspaceId
        );
      })
      .toBe(true);
    expect(heldSocketClosed).toBe(false);
    releaseProbe();
    await page.clock.resume();
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
    releaseProbe();
    await context.close();
    if (probeStarted) await expect.poll(() => heldSocketClosed).toBe(true);
    await workspace.cleanup();
  }
});
