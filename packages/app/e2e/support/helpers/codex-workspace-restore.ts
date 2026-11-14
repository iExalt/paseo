import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { TestInfo } from "@playwright/test";
import { test as base, expect, type Page } from "../fixtures";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { openSessions } from "./archive-tab";
import { getE2EDaemonPort } from "./daemon-port";
import { assertComposerIdle } from "./rewind-flow";
import { getServerId } from "./server-id";
import { archiveWorkspaceFromSidebar, expectWorkspaceAbsentFromSidebar } from "./sidebar";
import { createTempGitRepo } from "./workspace";
import { waitForSidebarHydration } from "./workspace-ui";
import type { SeedDaemonClient } from "./seed-client";

const REPLY = "CODEX_WORKTREE_RESTORE_READY";
const workspaceSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.literal("worktree"),
});

function runCliJson<T>(args: string[], options: { host: string; home: string; cwd: string }): T {
  const env = { ...process.env, PASEO_HOME: options.home } as NodeJS.ProcessEnv;
  delete env.PASEO_HOST;
  const paseoCli = path.resolve(process.cwd(), "../cli/bin/paseo");
  const output = execFileSync(
    process.execPath,
    [paseoCli, ...args, "--host", options.host, "--json"],
    { cwd: options.cwd, env, encoding: "utf8", timeout: 240_000 },
  );
  return JSON.parse(output) as T;
}

function defaultCodexModel(options: { host: string; home: string; cwd: string }): string {
  const result = z
    .object({ models: z.array(z.object({ id: z.string(), isDefault: z.boolean() })) })
    .parse(runCliJson(["provider", "models", "codex", "--full"], options));
  const model = result.models.find((entry) => entry.isDefault);
  if (!model) throw new Error("Codex did not advertise a default model");
  return model.id;
}

function recordTimelineWire(page: Page): string[] {
  const wire: string[] = [];
  page.on("websocket", (socket) => {
    const recordFrame = (direction: string, message: string) => {
      if (/agent.*timeline|fetch_agents|agent_update/.test(message)) {
        wire.push(JSON.stringify({ at: Date.now(), direction, message }));
      }
    };
    socket.on("framesent", ({ payload }) => recordFrame("sent", payload.toString()));
    socket.on("framereceived", ({ payload }) => recordFrame("received", payload.toString()));
  });
  return wire;
}

async function createCodexRestoreJourney(page: Page, client: SeedDaemonClient, info: TestInfo) {
  const repo = await createTempGitRepo("codex-worktree-restore-");
  const cliTarget = {
    host: `127.0.0.1:${getE2EDaemonPort()}`,
    home: process.env.E2E_PASEO_HOME ?? "",
    cwd: repo.path,
  };
  const wire = recordTimelineWire(page);
  let workspace: z.infer<typeof workspaceSchema> | undefined;
  let agentId: string | undefined;

  function created() {
    if (!workspace || !agentId) throw new Error("Create the Codex worktree before using it");
    return { ...workspace, agentId };
  }

  async function expectSelected() {
    await expect(page.getByTestId(`workspace-tab-agent_${created().agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }

  return {
    async createWorktreeWithCodex() {
      const createdWorkspace = runCliJson<{
        workspaceId: string;
        cwd: string;
        isolation: "worktree";
        workspace: { projectId: string };
      }>(
        [
          "workspace",
          "create",
          "--isolation",
          "worktree",
          "--path",
          repo.path,
          "--base",
          "main",
          "--title",
          "Codex worktree restore reproduction",
        ],
        cliTarget,
      );
      workspace = workspaceSchema.parse({
        workspaceId: createdWorkspace.workspaceId,
        projectId: createdWorkspace.workspace.projectId,
        cwd: createdWorkspace.cwd,
        isolation: createdWorkspace.isolation,
      });
      const agent = z
        .object({ agentId: z.string() })
        .parse(
          runCliJson(
            [
              "agent",
              "run",
              `Reply with exactly ${REPLY} and nothing else. Do not use tools.`,
              "--no-wait",
              "--workspace",
              workspace.workspaceId,
              "--provider",
              `codex/${defaultCodexModel(cliTarget)}`,
              "--mode",
              "full-access",
              "--thinking",
              "low",
              "--title",
              "Codex worktree restore reproduction",
            ],
            cliTarget,
          ),
        );
      agentId = agent.agentId;
    },
    async waitForCompletedReply() {
      const target = created();
      await page.goto(buildHostAgentDetailRoute(getServerId(), target.agentId, target.workspaceId));
      await waitForSidebarHydration(page);
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY, {
        timeout: 240_000,
      });
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { status: "idle", archivedAt: null },
        });
      await assertComposerIdle({ page });
    },
    async archiveBeforeBrowserConnects() {
      const target = created();
      await client.waitForFinish(target.agentId, 240_000);
      expect((await client.archiveWorkspace(target.workspaceId)).error).toBeNull();
      await expect.poll(() => existsSync(target.cwd)).toBe(false);
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { archivedAt: expect.any(String) },
        });
    },
    async connectFreshBrowser() {
      await page.goto("/");
    },
    async archiveWorkspaceFromSidebar() {
      await archiveWorkspaceFromSidebar(page, created().workspaceId);
    },
    async expectWorkspaceAndAgentArchived() {
      const target = created();
      await expectWorkspaceAbsentFromSidebar(page, target.workspaceId);
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { archivedAt: expect.any(String) },
        });
      await expect.poll(() => existsSync(target.cwd), { timeout: 30_000 }).toBe(false);
      await expect
        .poll(() => client.fetchWorkspaces())
        .not.toMatchObject({
          entries: expect.arrayContaining([expect.objectContaining({ id: target.workspaceId })]),
        });
    },
    async openArchivedWorkspaceFromHistory() {
      await openSessions(page);
      const row = page.getByTestId(`agent-row-${getServerId()}-${created().agentId}`);
      await expect(row).toContainText("Archived");
      await row.click();
      await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible();
    },
    async restoreWorkspace() {
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(page.getByText("Workspace archived", { exact: true })).toHaveCount(0, {
        timeout: 60_000,
      });
    },
    async expectWorktreeRestoredWithArchivedAgentSelected() {
      await expect.poll(() => existsSync(created().cwd), { timeout: 30_000 }).toBe(true);
      await expectSelected();
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await info.attach("after-workspace-restore", {
        body: JSON.stringify(await client.fetchAgent({ agentId: created().agentId }), null, 2),
        contentType: "application/json",
      });
    },
    async expectArchivedAgentSelectedWithHistory() {
      await expectSelected();
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY);
    },
    async reloadWithoutAgentCache() {
      const url = page.url();
      const cdp = await page.context().newCDPSession(page);
      // Unmount first so an open connection cannot repopulate the cache while it is cleared.
      await page.goto("about:blank");
      await cdp.send("Storage.clearDataForOrigin", {
        origin: new URL(url).origin,
        storageTypes: "indexeddb,cache_storage",
      });
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.goto(url);
      await cdp.detach();
    },
    async waitForWorkspaceHydration() {
      await waitForSidebarHydration(page);
    },
    async unarchiveAgent() {
      await page.getByRole("button", { name: "Unarchive", exact: true }).click({ timeout: 30_000 });
      await expect(page.getByText("This agent is archived", { exact: true })).toHaveCount(0, {
        timeout: 60_000,
      });
    },
    async expectIdleAgentWithVisibleComposer(statusTimeout?: number) {
      await expect
        .poll(() => client.fetchAgent({ agentId: created().agentId }), { timeout: statusTimeout })
        .toMatchObject({ agent: { status: "idle", archivedAt: null } });
      await expectSelected();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
      await assertComposerIdle({ page });
      await info.attach("restored-agent-screen", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await info.attach("restored-agent-accessibility", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
    },
    async dispose() {
      const testFailed = info.status !== info.expectedStatus;
      const errors: unknown[] = [];
      try {
        await info.attach("final-screen", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await info.attach("timeline-wire", { body: wire.join("\n"), contentType: "text/plain" });
        await info.attach("final-agent", {
          body: JSON.stringify(agentId ? await client.fetchAgent({ agentId }) : null, null, 2),
          contentType: "application/json",
        });
        await info.attach("daemon-log", {
          body: await readFile(path.join(process.env.E2E_PASEO_HOME!, "daemon.log")),
          contentType: "text/plain",
        });
      } catch (error) {
        errors.push(error);
      }
      const cleanup: Array<() => Promise<unknown>> = [];
      if (!testFailed || process.env.E2E_KEEP_PASEO_HOME !== "1") {
        const projectId = workspace?.projectId;
        if (projectId) cleanup.push(() => client.removeProject(projectId));
        cleanup.push(() => repo.cleanup());
      }
      for (const release of cleanup) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        const error = new AggregateError(errors, "Codex restore fixture teardown failed");
        if (!testFailed) throw error;
        // Keep the journey failure primary while reporting teardown failures in the test log.
        console.error(error);
      }
    },
  };
}

export const test = base.extend<{
  codexRestore: Awaited<ReturnType<typeof createCodexRestoreJourney>>;
}>({
  // This fixture owns cleanup so a failed reproduction can retain its daemon state.
  projectOwnership: async ({ e2eWorkerClient }, provide) => {
    void e2eWorkerClient;
    await provide();
  },
  codexRestore: async ({ page, e2eWorkerClient }, provide, info) => {
    const journey = await createCodexRestoreJourney(page, e2eWorkerClient, info);
    try {
      await provide(journey);
    } finally {
      await journey.dispose();
    }
  },
});
