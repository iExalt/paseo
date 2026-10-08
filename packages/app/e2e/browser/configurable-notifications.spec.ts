import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test as baseTest } from "../support/fixtures";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  buildHostWorkspaceRoute,
  buildSettingsHostSectionRoute,
} from "../../src/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";

const paseoCli = path.resolve(process.cwd(), "../cli/bin/paseo");

const test = baseTest.extend({
  e2eDaemonConfig: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
    async ({}, use) => {
      const manifestUrl = pathToFileURL(
        path.resolve(process.cwd(), "../protocol/dist/provider-manifest.js"),
      ).href;
      const { AGENT_PROVIDER_DEFINITIONS } = (await import(manifestUrl)) as {
        AGENT_PROVIDER_DEFINITIONS: Array<{ id: string }>;
      };
      await use({
        version: 1,
        agents: {
          providers: Object.fromEntries(
            AGENT_PROVIDER_DEFINITIONS.map(({ id }) => [id, { enabled: false }]),
          ),
          metadataGeneration: { providers: [] },
        },
      });
    },
    { scope: "worker" },
  ],
});

async function readWorkspaceNotifications(
  client: {
    fetchWorkspaces(): Promise<{ entries: Array<{ id: string; notifications?: string }> }>;
  },
  workspaceId: string,
): Promise<string | undefined> {
  const { entries } = await client.fetchWorkspaces();
  return entries.find((workspace) => workspace.id === workspaceId)?.notifications;
}

function runCliJson<T>(args: string[], options: { host: string; home: string; cwd: string }): T {
  const env = { ...process.env, PASEO_HOME: options.home } as NodeJS.ProcessEnv;
  delete env.PASEO_HOST;
  const output = execFileSync(
    process.execPath,
    [paseoCli, ...args, "--host", options.host, "--json"],
    { cwd: options.cwd, env, encoding: "utf8", timeout: 20_000 },
  );
  return JSON.parse(output) as T;
}

async function removeCreatedWorkspaceProject(
  client: {
    fetchWorkspaces(): Promise<{
      entries: Array<{ id: string; projectId: string; projectRootPath: string }>;
    }>;
    removeProject(projectId: string): Promise<unknown>;
  },
  input: { workspaceId?: string; projectId?: string; repoPath: string },
): Promise<void> {
  if (!input.workspaceId) return;
  const workspace = (await client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === input.workspaceId,
  );
  if (
    workspace?.projectRootPath === input.repoPath &&
    (!input.projectId || workspace.projectId === input.projectId)
  ) {
    await client.removeProject(workspace.projectId).catch(() => undefined);
  }
}

test.describe("configurable notifications journey", () => {
  test.describe.configure({ timeout: 120_000 });

  test("keeps workspace and reply rules authoritative across CLI, MCP, and live turns", async ({
    page,
    e2eWorkerClient,
  }, testInfo) => {
    const repo = await createTempGitRepo("paseo-s5c-notifications-");
    const cliTarget = {
      host: `127.0.0.1:${getE2EDaemonPort()}`,
      home: process.env.E2E_PASEO_HOME ?? "",
      cwd: repo.path,
    };
    let mcp: Client | undefined;
    let attentionObservation:
      | {
          ready: Promise<unknown>;
          subscribe(observer: {
            snapshot(snapshot: unknown): void;
            update(message: SessionOutboundMessage): void;
          }): () => void;
          release(): Promise<void>;
        }
      | undefined;
    let unsubscribeAttention: (() => void) | undefined;
    const attentionMessages: Array<
      Extract<SessionOutboundMessage, { type: "agent_attention_required" }>["payload"]
    > = [];
    const eventClient = e2eWorkerClient as typeof e2eWorkerClient & {
      observeEvents(
        events: Array<"agent_attention_required">,
        options?: { notifications?: boolean },
      ): NonNullable<typeof attentionObservation>;
    };
    let createdWorkspaceId: string | undefined;
    let createdProjectId: string | undefined;

    try {
      await page.addInitScript(() => {
        const calls: Array<{ title: string; body: string }> = [];
        Object.defineProperty(window, "__paseoNotificationCalls", { value: calls });
        class TestNotification {
          static permission = "granted";
          static requestPermission = async () => "granted";
          constructor(title: string, options?: { body?: string }) {
            calls.push({ title, body: options?.body ?? "" });
          }
          addEventListener() {}
        }
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: TestNotification,
        });
      });

      const credentialPath = path.join(process.env.E2E_PASEO_HOME ?? "", "local-credential");
      const localCredential = (await readFile(credentialPath, "utf8")).trim();
      mcp = new Client({ name: "notifications-browser-journey", version: "0.0.0" });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents`),
          { requestInit: { headers: { authorization: `Bearer ${localCredential}` } } },
        ),
      );
      attentionObservation = eventClient.observeEvents(["agent_attention_required"], {
        notifications: false,
      });
      unsubscribeAttention = attentionObservation.subscribe({
        snapshot: () => undefined,
        update: (message) => {
          if (message.type === "agent_attention_required") attentionMessages.push(message.payload);
        },
      });
      await attentionObservation.ready;

      const created = runCliJson<{ workspaceId: string; notifications: string }>(
        [
          "workspace",
          "create",
          "--isolation",
          "local",
          "--path",
          repo.path,
          "--title",
          "S5c notifications",
          "--notifications",
          "off",
        ],
        cliTarget,
      );
      const workspaceId = created.workspaceId;
      createdWorkspaceId = workspaceId;
      const createdWorkspace = (await e2eWorkerClient.fetchWorkspaces()).entries.find(
        (workspace) => workspace.id === workspaceId,
      );
      expect(createdWorkspace?.projectRootPath).toBe(repo.path);
      if (!createdWorkspace)
        throw new Error("CLI-created workspace was not returned by the daemon");
      createdProjectId = createdWorkspace.projectId;
      expect(created.notifications).toBe("off");
      const listedOff = runCliJson<Array<{ workspaceId: string; notifications: string }>>(
        ["workspace", "ls"],
        cliTarget,
      );
      expect(
        listedOff.find((workspace) => workspace.workspaceId === workspaceId)?.notifications,
      ).toBe("off");

      const serverId = getServerId();
      await page.goto(buildHostWorkspaceRoute(serverId, workspaceId), { waitUntil: "commit" });
      await expect(page.getByTestId("workspace-header-menu-trigger")).toBeVisible();
      await page.getByTestId("workspace-header-menu-trigger").click();
      const workspacePolicyItem = page.getByTestId("workspace-header-notifications");
      await expect(workspacePolicyItem).toContainText("Unmute notifications");
      await workspacePolicyItem.click();
      await expect.poll(() => readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("on");
      const cliListedOn = runCliJson<Array<{ workspaceId: string; notifications: string }>>(
        ["workspace", "ls"],
        cliTarget,
      );
      expect(
        cliListedOn.find((workspace) => workspace.workspaceId === workspaceId)?.notifications,
      ).toBe("on");
      const mcpListedOn = await mcp.callTool({ name: "list_workspaces", arguments: {} });
      expect(mcpListedOn.structuredContent).toMatchObject({
        workspaces: expect.arrayContaining([
          expect.objectContaining({ workspaceId, notifications: "on" }),
        ]),
      });
      await page.getByTestId("workspace-header-menu-trigger").click();
      await expect(workspacePolicyItem).toContainText("Mute notifications");

      const cliOff = runCliJson<{ workspaceId: string; notifications: string }>(
        ["workspace", "update", workspaceId, "--notifications", "off"],
        cliTarget,
      );
      expect(cliOff).toEqual({ workspaceId, notifications: "off" });
      await expect(workspacePolicyItem).toContainText("Unmute notifications");

      const externalOn = await mcp.callTool({
        name: "set_workspace_notifications",
        arguments: { workspaceId, notifications: "on" },
      });
      expect(externalOn.structuredContent).toEqual({ workspaceId, notifications: "on" });
      await expect(workspacePolicyItem).toContainText("Mute notifications");

      await page.goto(buildSettingsHostSectionRoute(serverId, "agents"), { waitUntil: "commit" });
      await expect(page.getByTestId("reply-rules-section")).toBeVisible();
      await expect(page.getByTestId("reply-rules-empty")).toBeVisible();
      await page.getByTestId("reply-rules-add").click();
      const sourceInput = page.getByTestId("reply-rule-source-0");
      const flagsInput = page.getByTestId("reply-rule-flags-0");
      const matchingRule = { source: "^No news\\.$", flags: "u" };
      await sourceInput.fill(matchingRule.source);
      await flagsInput.fill(matchingRule.flags);
      await page.getByTestId("reply-rules-save").click();
      await expect
        .poll(async () => {
          const result = await mcp!.callTool({
            name: "get_daemon_notification_rules",
            arguments: {},
          });
          return (result.structuredContent as { replyRules: unknown[] }).replyRules;
        })
        .toEqual([matchingRule]);

      await flagsInput.fill("x");
      await page.getByTestId("reply-rules-save").click();
      await expect(page.getByText(/Could not save rules:/)).toBeVisible();
      const retainedRules = await mcp.callTool({
        name: "get_daemon_notification_rules",
        arguments: {},
      });
      expect(retainedRules.structuredContent).toEqual({ replyRules: [matchingRule] });

      const externalRule = { source: "^External update\\.$", flags: "u" };
      const updatedRules = await mcp.callTool({
        name: "set_daemon_notification_rules",
        arguments: { replyRules: [externalRule] },
      });
      expect(updatedRules.structuredContent).toEqual({ replyRules: [externalRule] });
      await expect(page.getByTestId("reply-rules-conflict")).toBeVisible();
      await expect(sourceInput).toHaveValue(matchingRule.source);
      await expect(flagsInput).toHaveValue("x");
      await page.getByTestId("reply-rules-reload-saved").click();
      await expect(sourceInput).toHaveValue(externalRule.source);
      await expect(flagsInput).toHaveValue(externalRule.flags);
      await flagsInput.fill("u");
      await page.getByTestId("reply-rules-clear").click();
      await expect(page.getByTestId("reply-rules-empty")).toBeVisible();
      const clearedRules = await mcp.callTool({
        name: "get_daemon_notification_rules",
        arguments: {},
      });
      expect(clearedRules.structuredContent).toEqual({ replyRules: [] });

      const savedForDelivery = await mcp.callTool({
        name: "set_daemon_notification_rules",
        arguments: { replyRules: [matchingRule] },
      });
      expect(savedForDelivery.structuredContent).toEqual({ replyRules: [matchingRule] });
      await expect(sourceInput).toHaveValue(matchingRule.source);
      const evidenceDirectory = path.resolve(
        process.cwd(),
        "../../.dev/configurable-notifications/s5c",
      );
      await mkdir(evidenceDirectory, { recursive: true });
      await page.getByTestId("reply-rules-section").screenshot({
        path: `${evidenceDirectory}/reply-rules.png`,
        animations: "disabled",
      });

      const agent = await e2eWorkerClient.createAgent({
        provider: "mock",
        cwd: repo.path,
        workspaceId,
        title: "Notification controls",
        modeId: "load-test",
        model: "e2e-fast-stream",
        featureValues: {
          mockAssistantResponses: ["Unrelated answer", "Muted completion", "No news.", "No news."],
        },
      });
      const attentionForAgent = () =>
        attentionMessages.filter((message) => message.agentId === agent.id);
      const notificationCalls = () =>
        page.evaluate(() => {
          const calls = (
            window as unknown as Window & {
              __paseoNotificationCalls: Array<{ title: string; body: string }>;
            }
          ).__paseoNotificationCalls;
          return [...calls];
        });
      const attentionClient = e2eWorkerClient as typeof e2eWorkerClient & {
        clearAgentAttention(agentId: string): Promise<void>;
      };
      const turn = async (
        prompt: string,
        expectedBody: string,
        expectedNotifications: Array<{ title: string; body: string }>,
      ) => {
        // Attention is an edge-triggered unread state; clear the previous trial so each
        // completion exercises the same finished transition without changing focus.
        await attentionClient.clearAgentAttention(agent.id);
        const eventCount = attentionForAgent().length;
        await e2eWorkerClient.sendAgentMessage(agent.id, prompt);
        await e2eWorkerClient.waitForFinish(agent.id, 20_000);
        await expect.poll(() => attentionForAgent().length).toBe(eventCount + 1);
        expect(attentionForAgent().at(-1)?.reason).toBe("finished");
        expect(attentionForAgent().at(-1)?.notification?.body).toBe(expectedBody);
        if (expectedNotifications.length > (await notificationCalls()).length) {
          await expect.poll(notificationCalls).toHaveLength(expectedNotifications.length);
        }
        // The finished source event arrives after the server's notification decision.
        // Give the browser event handler a bounded window before asserting no extra call.
        await page.waitForTimeout(400);
        expect(await notificationCalls()).toEqual(expectedNotifications);
      };

      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("on");
      await turn("Send a non-matching completion", "Unrelated answer", [
        { title: "Agent finished", body: "Unrelated answer" },
      ]);

      const workspaceOff = await mcp.callTool({
        name: "set_workspace_notifications",
        arguments: { workspaceId, notifications: "off" },
      });
      expect(workspaceOff.structuredContent).toEqual({ workspaceId, notifications: "off" });
      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("off");
      await turn("Send a muted completion", "Muted completion", [
        { title: "Agent finished", body: "Unrelated answer" },
      ]);

      const workspaceOn = await mcp.callTool({
        name: "set_workspace_notifications",
        arguments: { workspaceId, notifications: "on" },
      });
      expect(workspaceOn.structuredContent).toEqual({ workspaceId, notifications: "on" });
      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("on");
      await turn("Send a matching completion", "No news.", [
        { title: "Agent finished", body: "Unrelated answer" },
      ]);
      const clearForDelivery = await mcp.callTool({
        name: "clear_daemon_notification_rules",
        arguments: {},
      });
      expect(clearForDelivery.structuredContent).toEqual({ replyRules: [] });
      await turn("Send the cleared-rule completion", "No news.", [
        { title: "Agent finished", body: "Unrelated answer" },
        { title: "Agent finished", body: "No news." },
      ]);

      await testInfo.attach("notification-evidence", {
        body: JSON.stringify(
          attentionForAgent().map(({ reason, shouldNotify, notification }) => ({
            reason,
            shouldNotify,
            body: notification?.body,
          })),
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      unsubscribeAttention?.();
      try {
        await attentionObservation?.release().catch(() => undefined);
      } finally {
        try {
          await mcp?.close().catch(() => undefined);
        } finally {
          try {
            await removeCreatedWorkspaceProject(e2eWorkerClient, {
              workspaceId: createdWorkspaceId,
              projectId: createdProjectId,
              repoPath: repo.path,
            });
          } finally {
            await repo.cleanup();
          }
        }
      }
    }
  });
});
