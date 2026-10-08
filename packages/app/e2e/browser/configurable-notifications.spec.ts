import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { chromium, devices, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as baseSupportTest } from "../support/fixtures";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  buildHostWorkspaceRoute,
  buildSettingsHostSectionRoute,
} from "../../src/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";

const paseoCli = path.resolve(process.cwd(), "../cli/bin/paseo");
const notificationOsProof = process.env.PASEO_NOTIFICATION_OS_PROOF === "1";

function getNotificationOsProofPaths(): {
  profilePath: string;
  proofRoot: string;
  runName: string;
} {
  const profilePath = process.env.PASEO_NOTIFICATION_OS_PROFILE;
  if (!profilePath) {
    throw new Error("PASEO_NOTIFICATION_OS_PROFILE must name a fresh disposable browser profile");
  }

  const repoRoot = path.resolve(process.cwd(), "../..");
  const proofRoot = path.join(repoRoot, ".dev/configurable-notifications");
  const resolvedProfile = path.resolve(profilePath);
  const relativeProfile = path.relative(proofRoot, resolvedProfile).split(path.sep);
  if (
    relativeProfile.length !== 2 ||
    !relativeProfile[0]?.startsWith("os-proof.") ||
    relativeProfile[1] !== "browser-profile"
  ) {
    throw new Error(
      `The notification proof profile must be a fresh browser-profile under ${proofRoot}/os-proof.*`,
    );
  }
  return { profilePath: resolvedProfile, proofRoot, runName: relativeProfile[0] };
}

function validateNotificationOsHome(
  paseoHome: string,
  paths: { proofRoot: string; runName: string },
  homeStage: "root" | "worker",
): void {
  const relativeHome = path.relative(paths.proofRoot, path.resolve(paseoHome)).split(path.sep);
  const isExpectedHome =
    homeStage === "root"
      ? relativeHome.length === 2 && relativeHome[1] === "paseo-home"
      : relativeHome.length === 3 &&
        relativeHome[1] === "paseo-home" &&
        /^worker-\d+$/u.test(relativeHome[2] ?? "");
  if (relativeHome[0] !== paths.runName || !isExpectedHome) {
    throw new Error(
      `E2E_PASEO_HOME must be the task-owned ${homeStage} home beside the browser profile`,
    );
  }
}

function validateNotificationOsEnvironment(homeStage: "root" | "worker"): void {
  if (process.env.E2E_FORK_PASEO_HOME_FROM?.trim()) {
    throw new Error(
      "The OS proof must not fork settings or provider metadata from another Paseo home",
    );
  }
  if (homeStage === "root") {
    if (process.env.E2E_WORKERS !== "1") {
      throw new Error("The OS proof requires E2E_WORKERS=1 for its single disposable home");
    }
    if (process.env.PASEO_HOME?.trim() || process.env.PASEO_HOST?.trim()) {
      throw new Error("Unset production Paseo home/host variables before starting the OS proof");
    }
  }
}

async function requireFreshNotificationOsProfile(homeStage: "root" | "worker"): Promise<string> {
  const paths = getNotificationOsProofPaths();
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) {
    throw new Error(
      "E2E_PASEO_HOME must point to the task-owned disposable notification proof home",
    );
  }
  validateNotificationOsHome(paseoHome, paths, homeStage);
  validateNotificationOsEnvironment(homeStage);
  let profileExists = false;
  try {
    await access(paths.profilePath);
    profileExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (profileExists) {
    throw new Error("The notification proof browser profile must not exist before this run");
  }
  return paths.profilePath;
}

function installNotificationRecorder(useOsProofRecorder: boolean): void {
  const calls: Array<{ title: string; body: string }> = [];
  Object.defineProperty(window, "__paseoNotificationCalls", { value: calls });

  if (useOsProofRecorder) {
    const nativeNotification = window.Notification;
    if (!nativeNotification) throw new Error("This browser does not support notifications");

    const recordedNotification = new Proxy(nativeNotification, {
      construct(target, args) {
        const [title, options] = args as [string, NotificationOptions?];
        calls.push({ title, body: options?.body ?? "" });
        return Reflect.construct(target, args, target);
      },
      get(target, property) {
        if (property === "requestPermission") return target.requestPermission.bind(target);
        return Reflect.get(target, property, target);
      },
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: recordedNotification,
    });

    const panel = document.createElement("section");
    panel.dataset.testid = "os-proof-panel";
    Object.assign(panel.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      maxWidth: "360px",
      padding: "10px 12px",
      border: "2px solid #444",
      borderRadius: "8px",
      background: "#fff",
      color: "#111",
      boxShadow: "0 2px 12px #0004",
      font: "13px/1.4 system-ui, sans-serif",
      pointerEvents: "none",
    });
    const trial = document.createElement("div");
    trial.dataset.testid = "os-proof-trial";
    trial.textContent = "Notification OS proof is preparing";
    const observationNote = document.createElement("div");
    observationNote.textContent =
      "The test grants this site permission only. macOS notification authorization is separate; observe the banner or Notification Center.";
    panel.append(trial, observationNote);
    const attachPanel = () => document.body.append(panel);
    if (document.body) attachPanel();
    else document.addEventListener("DOMContentLoaded", attachPanel, { once: true });
    Object.defineProperty(window, "__paseoSetNotificationTrial", {
      value: (label: string) => {
        trial.textContent = label;
      },
    });
    return;
  }

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
}

async function showNotificationTrial(page: Page, label: string): Promise<void> {
  if (!notificationOsProof) return;
  console.log(`[notification OS proof] ${label}`);
  await page.evaluate((nextLabel) => {
    const target = window as Window & {
      __paseoSetNotificationTrial?: (value: string) => void;
    };
    target.__paseoSetNotificationTrial?.(nextLabel);
  }, label);
}

const osProofBaseTest = baseSupportTest.extend({
  page: async (
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
    {},
    provide,
  ) => {
    const profilePath = await requireFreshNotificationOsProfile("worker");
    const metroPort = process.env.E2E_METRO_PORT;
    if (!metroPort) throw new Error("E2E_METRO_PORT must be set by Playwright global setup");
    const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${metroPort}`;
    const parsedBaseURL = new URL(baseURL);
    if (parsedBaseURL.hostname !== "localhost" || parsedBaseURL.port !== metroPort) {
      throw new Error("The OS proof browser must use the isolated loopback Metro URL");
    }

    const context = await chromium.launchPersistentContext(profilePath, {
      ...devices["Desktop Chrome"],
      baseURL,
      headless: false,
    });
    try {
      await context.grantPermissions(["notifications"], { origin: baseURL });
      console.log(
        `[notification OS proof] Browser-site notification permission granted for ${baseURL}; macOS authorization is unchanged.`,
      );
      await provide(context.pages()[0] ?? (await context.newPage()));
    } finally {
      await context.close();
    }
  },
});

const selectedBaseTest = notificationOsProof ? osProofBaseTest : baseSupportTest;

const test = selectedBaseTest.extend({
  e2eDaemonConfig: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
    async ({}, use) => {
      if (notificationOsProof) {
        const paseoHomeRoot = process.env.E2E_PASEO_HOME;
        if (!paseoHomeRoot) throw new Error("E2E_PASEO_HOME is required for the OS proof");
        await requireFreshNotificationOsProfile("root");
        await mkdir(path.join(paseoHomeRoot, "worker-0"), { recursive: true });
      }
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
  test.describe.configure({ timeout: notificationOsProof ? 300_000 : 120_000 });

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
      await page.addInitScript(installNotificationRecorder, notificationOsProof);

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
      if (notificationOsProof) {
        const permission = await page.evaluate(
          () => window.Notification?.permission ?? "unsupported",
        );
        if (permission !== "granted") {
          throw new Error(`Notification permission is '${permission}', expected 'granted'`);
        }
      }
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
        trialLabel: string,
      ) => {
        await showNotificationTrial(page, trialLabel);
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
        await page.waitForTimeout(notificationOsProof ? 10_000 : 400);
        expect(await notificationCalls()).toEqual(expectedNotifications);
      };

      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("on");
      await turn(
        "Send a non-matching completion",
        "Unrelated answer",
        [{ title: "Agent finished", body: "Unrelated answer" }],
        "Trial 1/4: notification expected — workspace on, no rule match, reply: Unrelated answer",
      );

      const workspaceOff = await mcp.callTool({
        name: "set_workspace_notifications",
        arguments: { workspaceId, notifications: "off" },
      });
      expect(workspaceOff.structuredContent).toEqual({ workspaceId, notifications: "off" });
      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("off");
      await turn(
        "Send a muted completion",
        "Muted completion",
        [{ title: "Agent finished", body: "Unrelated answer" }],
        "Trial 2/4: suppressed — workspace off, reply: Muted completion",
      );

      const workspaceOn = await mcp.callTool({
        name: "set_workspace_notifications",
        arguments: { workspaceId, notifications: "on" },
      });
      expect(workspaceOn.structuredContent).toEqual({ workspaceId, notifications: "on" });
      expect(await readWorkspaceNotifications(e2eWorkerClient, workspaceId)).toBe("on");
      await turn(
        "Send a matching completion",
        "No news.",
        [{ title: "Agent finished", body: "Unrelated answer" }],
        "Trial 3/4: suppressed — matching reply rule, reply: No news.",
      );
      const clearForDelivery = await mcp.callTool({
        name: "clear_daemon_notification_rules",
        arguments: {},
      });
      expect(clearForDelivery.structuredContent).toEqual({ replyRules: [] });
      await turn(
        "Send the cleared-rule completion",
        "No news.",
        [
          { title: "Agent finished", body: "Unrelated answer" },
          { title: "Agent finished", body: "No news." },
        ],
        "Trial 4/4: notification expected — rules cleared, reply: No news.",
      );

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
