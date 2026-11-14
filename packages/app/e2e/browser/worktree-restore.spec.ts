import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  restoreArchivedWorkspace,
  expectCommittedFile,
  expectCommittedFileAfterReload,
} from "../support/helpers/workspace-recovery";
import { archiveWorkspaceFromSidebar } from "../support/helpers/sidebar";
import { rename } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, metroTest, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectWorkspaceBranch,
  openChangesPanel,
  switchBranchFromChangesPanel,
} from "../support/helpers/branch-switcher";
import {
  createIdleAgent,
  expectSessionRowNotArchived,
  fetchAgentArchivedAt,
  openSessions,
} from "../support/helpers/archive-tab";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { connectSeedClient } from "../support/helpers/seed-client";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

test.describe("Worktree restore", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-restore-");
  });

  async function createArchivedMissingWorktree(
    prefix: string,
    options: { agentCount?: number; keepAgentsArchived?: boolean } = {},
  ) {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `${prefix}-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    const agents = await Promise.all(
      Array.from({ length: options.agentCount ?? 1 }, () =>
        createIdleAgent(client, {
          cwd: worktree.workspaceDirectory,
          workspaceId: worktree.workspaceId,
          title: `${prefix}-${randomUUID().slice(0, 8)}`,
        }),
      ),
    );
    const agent = agents[0];
    if (!agent) {
      throw new Error("Expected at least one archived-worktree agent");
    }

    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    // The production worktree archive owns both lifecycle records. Keep this
    // helper for cases that intentionally verify archived agents stay archived.
    for (const archivedAgent of agents) {
      await expect
        .poll(() => fetchAgentArchivedAt(client, archivedAgent.id), { timeout: 30_000 })
        .not.toBeNull();
    }
    expect(existsSync(worktree.workspaceDirectory)).toBe(false);

    return { agent, agents, worktree };
  }

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(worktreeClient, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    for (const projectId of createdProjectIds) {
      await worktreeClient.removeProject(projectId).catch(() => undefined);
    }
    createdProjectIds.clear();
    await client?.close().catch(() => undefined);
    await worktreeClient?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  async function createWorkspaceWithCommittedChange() {
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `restore-diff-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    commitRestorableChange(worktree.workspaceDirectory);
    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: "Restore committed changes",
    });
    const route = `${buildHostWorkspaceRoute(getServerId(), worktree.workspaceId)}?open=${encodeURIComponent(`agent:${agent.id}`)}`;

    return { worktree, route };
  }

  test("committed changes survive archive, restore and page reload", async ({ page }) => {
    const { worktree, route } = await createWorkspaceWithCommittedChange();
    await openCommittedWorkspace(page, route);
    await archiveCommittedWorkspace(page, worktree);
    await restoreCommittedWorkspace(page, route);
    await expectCommittedFileAfterReload(page, "restored-change.txt");
    await expectRestoredCommitDiff(page);
  });

  test("opening an active History agent navigates without restoring or unarchiving", async ({
    page,
  }) => {
    const serverId = getServerId();
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowNotArchived(page, agent.title);

    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0);
    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await openSessions(page);
    await expectSessionRowNotArchived(page, agent.title);
    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`workspace-deck-entry-${serverId}:${worktree.workspaceId}`),
    ).toHaveCount(1);
    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
  });

  test("restores the workspace before explicitly unarchiving each selected agent", async ({
    page,
  }) => {
    const { agents, worktree } = await createArchivedMissingWorktree("restore-agents", {
      agentCount: 2,
    });
    const [firstAgent, secondAgent] = agents;
    if (!firstAgent || !secondAgent) {
      throw new Error("Expected two archived agents");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await page.getByTestId(`agent-row-${getServerId()}-${firstAgent.id}`).click();

    await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("workspace-recovery-action").click();
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(true);
    await expect(
      page.getByTestId(`workspace-tab-agent_${firstAgent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`workspace-tab-agent_${firstAgent.id}`).filter({ visible: true }).first(),
    ).toHaveAttribute("aria-selected", "true");
    expect(await fetchAgentArchivedAt(client, firstAgent.id)).not.toBeNull();
    expect(await fetchAgentArchivedAt(client, secondAgent.id)).not.toBeNull();
    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect
      .poll(() => fetchAgentArchivedAt(client, firstAgent.id), { timeout: 30_000 })
      .toBeNull();
    expect(await fetchAgentArchivedAt(client, secondAgent.id)).not.toBeNull();
    await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0, {
      timeout: 30_000,
    });

    await openSessions(page);
    await page.getByTestId(`agent-row-${getServerId()}-${secondAgent.id}`).click();
    await expect(
      page.getByTestId(`workspace-tab-agent_${secondAgent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Unarchive" }).click();
    await expect
      .poll(() => fetchAgentArchivedAt(client, secondAgent.id), { timeout: 30_000 })
      .toBeNull();
  });

  test("restores a branchless workspace so its archived agent can be used again", async ({
    page,
  }) => {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const backingWorktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `branchless-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(backingWorktree.projectKey);
    createdWorktreeDirectories.add(backingWorktree.workspaceDirectory);

    execFileSync("git", ["switch", "--detach", "main"], {
      cwd: backingWorktree.workspaceDirectory,
      stdio: "pipe",
    });
    const created = await worktreeClient.createWorkspace({
      source: { kind: "directory", path: backingWorktree.workspaceDirectory },
      title: "Sample workspace",
    });
    if (!created.workspace) {
      throw new Error(created.error ?? "Could not create the branchless workspace");
    }
    const workspaceId = created.workspace.id;
    const agent = await createIdleAgent(client, {
      cwd: backingWorktree.workspaceDirectory,
      workspaceId,
      title: "Archived agent",
    });

    await archiveWorkspaceFromDaemon(worktreeClient, backingWorktree.workspaceDirectory, {
      scope: "worktree",
    });
    await expect
      .poll(() => existsSync(backingWorktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id)).not.toBeNull();

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await page.getByTestId(`agent-row-${getServerId()}-${agent.id}`).click();
    await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Restore Sample workspace to return to its agents. A new branch will start from the saved base or the repository default.",
        { exact: true },
      ),
    ).toBeVisible();
    await captureBranchlessRestoreStep(page, "01-restore-workspace.png");

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect
      .poll(() => existsSync(backingWorktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(true);
    await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await captureBranchlessRestoreStep(page, "02-unarchive-agent.png");

    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id)).toBeNull();
    await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable();
    await captureBranchlessRestoreStep(page, "03-agent-ready.png");

    const restoredHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: backingWorktree.workspaceDirectory,
      encoding: "utf8",
    }).trim();
    const defaultHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: tempRepo.path,
      encoding: "utf8",
    }).trim();
    expect(restoredHead).toBe(defaultHead);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: backingWorktree.workspaceDirectory,
        encoding: "utf8",
      }).trim(),
    ).toMatch(/^restored\//);
  });

  test("an unrecoverable missing workspace shows no misleading recovery action", async ({
    page,
  }) => {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const agent = await createIdleAgent(client, {
      cwd: project.workspaceDirectory,
      workspaceId: project.workspaceId,
      title: `unrecoverable-${randomUUID().slice(0, 8)}`,
    });
    await archiveLocalWorkspaceFromDaemon(worktreeClient, project.workspaceId);
    await client.refreshAgent(agent.id).catch(() => undefined);
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id), { timeout: 30_000 }).toBeNull();

    const displacedProjectPath = `${tempRepo.path}-missing`;
    await rename(tempRepo.path, displacedProjectPath);
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openSessions(page);
      await expectSessionRowNotArchived(page, agent.title);
      await page.getByTestId(`agent-row-${getServerId()}-${agent.id}`).click();

      await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(
          "The archived workspace directory no longer exists and cannot be recreated.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
    } finally {
      await rename(displacedProjectPath, tempRepo.path);
    }
  });
});

type SeedClient = Awaited<ReturnType<typeof connectSeedClient>>;
type WorktreeClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
type Worktree = Awaited<ReturnType<typeof createWorktreeViaDaemon>>;

interface HistoricalRecoveryFixture {
  agent: { id: string; title: string; cwd: string; workspaceId: string };
  client: SeedClient;
  serverId: string;
  tempRepo: Awaited<ReturnType<typeof createTempGitRepo>>;
  worktree: Worktree;
  worktreeClient: WorktreeClient;
  cleanup(): Promise<void>;
}

const historicalRecoveryTest = metroTest.extend<{
  historicalRecovery: HistoricalRecoveryFixture;
}>({
  historicalRecovery: async ({ page }, provide) => {
    const fixture = await createHistoricalRecoveryFixture(page);
    try {
      await provide(fixture);
    } finally {
      await fixture.cleanup();
    }
  },
});

async function createHistoricalRecoveryFixture(page: Page): Promise<HistoricalRecoveryFixture> {
  const serverId = `srv_worktree_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-e2e-historical-worktree-home-"));
  const tempRepo = await createTempGitRepo("wt-historical-");
  let daemon: IsolatedHostDaemon | undefined;
  let client: SeedClient | undefined;
  let worktreeClient: WorktreeClient | undefined;
  let worktree: Worktree | undefined;

  const cleanup = async () => {
    if (daemon && worktreeClient && worktree && existsSync(worktree.workspaceDirectory)) {
      await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory).catch(
        () => undefined,
      );
    }
    await client?.close().catch(() => undefined);
    await worktreeClient?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await tempRepo.cleanup().catch(() => undefined);
    await rm(paseoHome, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    daemon = await startIsolatedHostDaemon(serverId, { paseoHome, preserveHome: true });
    client = await connectSeedClient({ port: daemon.port, projectOwnership: "host" });
    worktreeClient = await connectNewWorkspaceDaemonClient({
      port: daemon.port,
      ownProjects: false,
    });

    await openProjectViaDaemon(worktreeClient, tempRepo.path);
    worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `historical-${randomUUID().slice(0, 8)}`,
    });
    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree!.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);
    await expect(
      worktreeClient.inspectWorkspaceRecovery(worktree.workspaceId),
    ).resolves.toMatchObject({
      kind: "recoverable",
      action: "restore",
    });

    await client.close();
    client = undefined;
    await worktreeClient.close();
    worktreeClient = undefined;
    await daemon.close();
    daemon = undefined;

    const now = new Date().toISOString();
    const candidateAgent = {
      id: randomUUID(),
      provider: "mock",
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      lastUserMessageAt: null,
      title: `Historical archived-workspace ${randomUUID().slice(0, 8)}`,
      labels: {},
      lastStatus: "closed",
      resumeOnStartup: false,
      lastModeId: "load-test",
      config: null,
      persistence: null,
      archivedAt: null,
    };
    // Keep server source out of Playwright's module graph while using its actual parser.
    const agentStorageUrl = pathToFileURL(
      path.resolve(process.cwd(), "../server/src/server/agent/agent-storage.js"),
    ).href;
    const parseAgentScript = [
      'import { readFileSync } from "node:fs";',
      `import { parseStoredAgentRecord } from ${JSON.stringify(agentStorageUrl)};`,
      'process.stdout.write(JSON.stringify(parseStoredAgentRecord(JSON.parse(readFileSync(0, "utf8")))));',
    ].join("\n");
    const normalizedAgentJson = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", parseAgentScript],
      {
        cwd: process.cwd(),
        input: JSON.stringify(candidateAgent),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    const agent = JSON.parse(normalizedAgentJson) as typeof candidateAgent;
    const agentDirectory = path.join(paseoHome, "agents", projectDirNameFromCwd(agent.cwd));
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      path.join(agentDirectory, `${agent.id}.json`),
      `${JSON.stringify(agent, null, 2)}\n`,
    );

    daemon = await startIsolatedHostDaemon(serverId, { paseoHome, preserveHome: true });
    client = await connectSeedClient({ port: daemon.port, projectOwnership: "host" });
    worktreeClient = await connectNewWorkspaceDaemonClient({
      port: daemon.port,
      ownProjects: false,
    });

    let historicalAgents: Awaited<ReturnType<SeedClient["fetchAgentHistory"]>> | undefined;
    try {
      await expect
        .poll(async () => {
          historicalAgents = await client!.fetchAgentHistory({ page: { limit: 100 } });
          return historicalAgents.entries.find((entry) => entry.agent.id === agent.id)?.agent;
        })
        .toMatchObject({
          id: agent.id,
          workspaceId: worktree.workspaceId,
          cwd: agent.cwd,
          status: "closed",
          archivedAt: null,
        });
    } finally {
      await historicalRecoveryTest
        .info()
        .attach("historical-agent-history", {
          body: JSON.stringify(historicalAgents ?? { response: "not received" }, null, 2),
          contentType: "application/json",
        })
        .catch((error: unknown) =>
          console.error("Could not attach historical agent response", error),
        );
    }
    await expect.poll(() => fetchAgentArchivedAt(client!, agent.id)).toBeNull();
    expect(await client.fetchAgent({ agentId: agent.id })).not.toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(false);
    await expect(
      worktreeClient.inspectWorkspaceRecovery(worktree.workspaceId),
    ).resolves.toMatchObject({
      kind: "recoverable",
      action: "restore",
    });
    console.log("[worktree-restore] persisted fixture pre-UI preconditions passed");

    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      label: "historical worktree restore",
      nowIso: new Date().toISOString(),
    });
    await page.addInitScript(
      ({ seededHost, preferences }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
        localStorage.removeItem("@paseo:settings");
        localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      },
      { seededHost: host, preferences: buildCreateAgentPreferences() },
    );

    return {
      agent: {
        id: agent.id,
        title: agent.title ?? "",
        cwd: agent.cwd,
        workspaceId: worktree.workspaceId,
      },
      client,
      serverId,
      tempRepo,
      worktree,
      worktreeClient,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function projectDirNameFromCwd(cwd: string): string {
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? `${sanitizedRoot}-` : "";
  if (!withoutRoot) return sanitizedRoot || "root";
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

async function openHistoricalWorkspaceFromHistory(
  page: Page,
  fixture: HistoricalRecoveryFixture,
): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await openSessions(page);
  await expectSessionRowNotArchived(page, fixture.agent.title);
  await page.getByTestId(`agent-row-${fixture.serverId}-${fixture.agent.id}`).click();
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Restore");
}

async function openHistoricalAgentBeforeWorkspaceHydration(
  page: Page,
  fixture: HistoricalRecoveryFixture,
): Promise<void> {
  const workspaceRoute = buildHostWorkspaceRoute(fixture.serverId, fixture.worktree.workspaceId);
  const openAgent = encodeURIComponent(`agent:${fixture.agent.id}`);
  await page.goto(`${workspaceRoute}?open=${openAgent}`);
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Restore");
}

historicalRecoveryTest.describe("Worktree restore from a persisted historical snapshot", () => {
  historicalRecoveryTest.describe.configure({ timeout: 120_000 });

  historicalRecoveryTest(
    "recoverable History entries expose Restore without mutating either record",
    async ({ page, historicalRecovery }) => {
      await openHistoricalWorkspaceFromHistory(page, historicalRecovery);
      expect(
        await fetchAgentArchivedAt(historicalRecovery.client, historicalRecovery.agent.id),
      ).toBeNull();
      expect(existsSync(historicalRecovery.worktree.workspaceDirectory)).toBe(false);
      await expect(
        historicalRecovery.worktreeClient.inspectWorkspaceRecovery(
          historicalRecovery.worktree.workspaceId,
        ),
      ).resolves.toMatchObject({ kind: "recoverable", action: "restore" });
      console.log("[worktree-restore] History no-mutation UI assertion passed");
    },
  );

  historicalRecoveryTest(
    "explicit Restore shows loading, broadcasts and opens the live worktree",
    async ({ page, historicalRecovery }) => {
      const { agent, worktree, client, serverId, tempRepo, worktreeClient } = historicalRecovery;
      await openHistoricalAgentBeforeWorkspaceHydration(page, historicalRecovery);
      await worktreeClient.fetchWorkspaces({ subscribe: {} });
      let updateTimeout: ReturnType<typeof setTimeout> | null = null;
      let unsubscribeSecondaryWorkspaceUpdate = () => {};
      const secondaryWorkspaceUpdate = new Promise<void>((resolve, reject) => {
        updateTimeout = setTimeout(
          () => reject(new Error("Secondary client did not receive the restored workspace")),
          30_000,
        );
        unsubscribeSecondaryWorkspaceUpdate = worktreeClient.on("workspace_update", (message) => {
          if (
            message.payload.kind === "upsert" &&
            message.payload.workspace.id === worktree.workspaceId
          ) {
            resolve();
          }
        });
      });

      try {
        await page.getByTestId("workspace-recovery-action").click();
        await expect(page.getByText("Restoring workspace", { exact: true })).toBeVisible();
        await expect
          .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
          .toBe(true);
        await secondaryWorkspaceUpdate;
        await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });
        await expect(
          page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
        expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
      } finally {
        unsubscribeSecondaryWorkspaceUpdate();
        if (updateTimeout) clearTimeout(updateTimeout);
      }

      const switchedBranch = `restored-live-${randomUUID().slice(0, 8)}`;
      execFileSync("git", ["branch", switchedBranch], { cwd: tempRepo.path, stdio: "pipe" });
      await openChangesPanel(page);
      await expectWorkspaceBranch(page, worktree.workspaceName);
      await switchBranchFromChangesPanel(page, {
        from: worktree.workspaceName,
        to: switchedBranch,
      });
      await expectWorkspaceBranch(page, switchedBranch);
      await expect(
        page.getByTestId("workspace-header-title").filter({ visible: true }).first(),
      ).toHaveText(switchedBranch, { timeout: 30_000 });
    },
  );

  historicalRecoveryTest(
    "restore failure stays visible and permits a successful retry",
    async ({ page, historicalRecovery }) => {
      const { agent, worktree, tempRepo, serverId } = historicalRecovery;
      await openHistoricalWorkspaceFromHistory(page, historicalRecovery);
      const displacedProjectPath = `${tempRepo.path}-temporarily-unavailable`;
      await rename(tempRepo.path, displacedProjectPath);

      try {
        await page.getByTestId("workspace-recovery-action").click();
        await expect(page.getByTestId("workspace-recovery-error")).toHaveText(
          "The source repository needed to restore this worktree no longer exists.",
        );
        await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Retry");
        expect(existsSync(worktree.workspaceDirectory)).toBe(false);
      } finally {
        await rename(displacedProjectPath, tempRepo.path);
      }

      await page.getByTestId("workspace-recovery-action").click();
      await expect
        .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
        .toBe(true);
      await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });
      await expect(
        page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
    },
  );
});

async function captureBranchlessRestoreStep(page: Page, filename: string): Promise<void> {
  const screenshotDirectory = path.join(tmpdir(), "paseo-branchless-restore-evidence");
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, filename), fullPage: true });
}

function commitRestorableChange(cwd: string): void {
  writeFileSync(path.join(cwd, "restored-change.txt"), "preserved after restore\n");
  execFileSync("git", ["add", "restored-change.txt"], { cwd, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Preserve restored diff"], {
    cwd,
    stdio: "pipe",
  });
}

async function openCommittedWorkspace(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expectCommittedFile(page, "restored-change.txt");
}

async function archiveCommittedWorkspace(
  page: Page,
  worktree: { workspaceId: string; workspaceDirectory: string },
): Promise<void> {
  await archiveWorkspaceFromSidebar(page, worktree.workspaceId);
  await expect.poll(() => existsSync(worktree.workspaceDirectory)).toBe(false);
}

async function restoreCommittedWorkspace(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await restoreArchivedWorkspace(page);
}

async function expectRestoredCommitDiff(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Commits/i }).click();
  await page.getByText("Preserve restored diff", { exact: true }).click();
  // Diff file headers have no semantic role; their accessible names identify the file and counts.
  await expect(
    page.getByTestId("commit-diff-panel").filter({ visible: true }).getByTestId("diff-file-0"),
  ).toHaveAccessibleName("restored-change.txt, +1, -0");
  await page.screenshot({ path: test.info().outputPath("restored-commit.png") });
}
