import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { waitForWorkspaceInReplicaCache } from "../support/helpers/replica-cache-storage";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function archiveWorkspaceOutsideTheApp(workspace: SeededWorkspace): Promise<void> {
  const result = await workspace.client.archiveWorkspace(workspace.workspaceId);
  expect(result.error).toBeNull();
}

test.describe("Workspace archive cache coherence", () => {
  test("an archived selected workspace cannot return from the durable cache", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-cache-" });
    const available = await seedWorkspace({ repoPrefix: "archive-cache-next-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await waitForWorkspaceInReplicaCache(page, workspace.workspaceId);

      await archiveWorkspaceOutsideTheApp(workspace);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      await expectAppRoute(page, "/open-project");
      await expect(page.getByTestId("open-project-submit")).toBeVisible();

      // Cold startup must not restore the deleted selection from durable state.
      await gotoAppShell(page);
      await expectAppRoute(page, "/open-project");
      await expect(page.getByTestId("open-project-submit")).toBeVisible();

      // A direct stale link also returns to a usable menu.
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await expectAppRoute(page, "/open-project");
      await expect(page.getByTestId("open-project-submit")).toBeVisible();

      await selectWorkspaceInSidebar(page, available.workspaceId);
      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), available.workspaceId));
      await expect(page.getByTestId("open-project-submit")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
      await available.cleanup();
    }
  });

  test("an unavailable retained workspace does not interrupt Settings", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-hidden-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await openSettings(page);

      await archiveWorkspaceOutsideTheApp(workspace);
      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      await expectAppRoute(page, "/settings/general");
      await expect(page.getByTestId("open-project-submit")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
