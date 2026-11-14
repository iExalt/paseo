import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

interface RecordedNotification {
  title: string;
  tag: string | null;
  renotify: boolean | null;
  reason: string | null;
  closed: boolean;
}

/** Longer than the dismissal grace period, so a premature close would have happened. */
const SETTLE_MS = 3_000;

function installNotificationRecorder(): void {
  const records: RecordedNotification[] = [];
  Object.defineProperty(window, "__paseoNotifications", { value: records });
  class TestNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    private readonly record: RecordedNotification;
    constructor(
      title: string,
      options?: { tag?: string; renotify?: boolean; data?: { reason?: string } },
    ) {
      this.record = {
        title,
        tag: options?.tag ?? null,
        renotify: options?.renotify ?? null,
        reason: options?.data?.reason ?? null,
        closed: false,
      };
      records.push(this.record);
    }
    addEventListener() {}
    close() {
      this.record.closed = true;
    }
  }
  Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
}

function readNotifications(page: Page): Promise<RecordedNotification[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __paseoNotifications: RecordedNotification[] }).__paseoNotifications,
  );
}

async function waitForNotificationCount(page: Page, count: number): Promise<RecordedNotification> {
  await expect
    .poll(async () => (await readNotifications(page)).length, { timeout: 30_000 })
    .toBe(count);
  const notifications = await readNotifications(page);
  return notifications[count - 1]!;
}

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`).first();
}

/** In-app navigation; a page load would discard the notifications under test. */
async function openWorkspace(page: Page, workspaceId: string): Promise<void> {
  await selectWorkspaceInSidebar(page, workspaceId);
  await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), workspaceId));
}

test.describe("Notification dismissal", () => {
  test("closes a thread's notification once it is read, answered or archived", async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(installNotificationRecorder);
    const seeded = await seedWorkspace({ repoPrefix: "notification-dismissal-" });
    try {
      const away = await seeded.client.createWorkspace({
        source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
        title: "Away workspace",
      });
      if (!away.workspace) throw new Error(away.error ?? "Failed to create the away workspace");
      const awayId = away.workspace.id;
      const agent = await seeded.client.createAgent({
        provider: "mock",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "Dismissal agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });
      await gotoWorkspace(page, awayId);
      await waitForSidebarHydration(page);

      // Finished turn: stays while unread, closes once the thread is opened.
      await seeded.client.sendAgentMessage(agent.id, "Say hello.");
      const finished = await waitForNotificationCount(page, 1);
      expect(finished).toMatchObject({ reason: "finished", renotify: true, closed: false });
      expect(finished.tag).toContain(encodeURIComponent(agent.id));
      await expect(
        workspaceRow(page, seeded.workspaceId).getByTestId("workspace-status-indicator-attention"),
      ).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      expect((await readNotifications(page))[0]?.closed).toBe(false);
      await openWorkspace(page, seeded.workspaceId);
      await expect.poll(async () => (await readNotifications(page))[0]?.closed).toBe(true);

      // Question: reading the thread is not enough; answering it is.
      await openWorkspace(page, awayId);
      await seeded.client.sendAgentMessage(agent.id, "Emit synthetic plan approval.");
      const question = await waitForNotificationCount(page, 2);
      expect(question).toMatchObject({ reason: "permission", tag: finished.tag, closed: false });
      await openWorkspace(page, seeded.workspaceId);
      await waitForPermissionPrompt(page);
      await page.waitForTimeout(SETTLE_MS);
      expect((await readNotifications(page))[1]?.closed).toBe(false);
      await allowPermission(page);
      await expect.poll(async () => (await readNotifications(page))[1]?.closed).toBe(true);

      // Archive: closes without the thread being read.
      await openWorkspace(page, awayId);
      const count = (await readNotifications(page)).length;
      await seeded.client.sendAgentMessage(agent.id, "Say goodbye.");
      await waitForNotificationCount(page, count + 1);
      await seeded.client.archiveAgent(agent.id);
      await expect.poll(async () => (await readNotifications(page))[count]?.closed).toBe(true);
    } finally {
      await seeded.cleanup();
    }
  });
});
