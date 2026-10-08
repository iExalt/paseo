import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { ReplyRuleMatcher } from "./agent/reply-rule-matcher.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    completionSubject?: {
      turnId: string;
      text: string;
      completeness: "complete" | "incomplete";
    };
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
  broadcastDaemonConfigChanged(config: {
    replyRules?: Array<{ source: string; flags: string }>;
  }): void;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(
  agentManagerOverrides?: Record<string, unknown>,
  workspaceRegistry?: WorkspaceRegistry,
  daemonConfigStoreOverrides?: Record<string, unknown>,
) {
  const pushNotifications = new RecordingPushNotificationSender();
  const logger = createLogger();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
    getReplyRules: vi.fn(() => []),
    matchesReplyRules: vi.fn(() => false),
    ...daemonConfigStoreOverrides,
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(logger),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    workspaceRegistry,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications, daemonConfigStore, logger };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: {
    subscribed?: boolean;
    modern?: boolean;
    replyRuleNotifications?: boolean;
    subscribe?: (agent: { workspaceId?: string }) => Promise<boolean>;
  } = {},
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: (capability: string) =>
      capability === "reply_rule_notifications" && options.replyRuleNotifications === true,
    subscribesToAgent: vi.fn(
      (agent: { workspaceId?: string }) =>
        options.subscribe?.(agent) ?? Promise.resolve(options.subscribed ?? true),
    ),
    wantsSourceEvent: vi.fn(() => true),
    publishToSource: vi.fn(),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean; modern?: boolean; replyRuleNotifications?: boolean } = {},
) {
  const ws = createOpenSocket();
  const delivery = new SessionDelivery(() => {});
  delivery.attach(ws, options.modern === true);
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: {
      ...createSessionWithActivity(activity, options),
      delivery,
      wantsSourceNotification: () => true,
    },
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readModernAttentionPayload(server: VoiceAssistantWebSocketServer, ws: object) {
  const connection = asInternals<{ sessions: Map<unknown, unknown> }>(server).sessions.get(ws) as
    | { session: { publishToSource: ReturnType<typeof vi.fn> } }
    | undefined;
  const message = connection?.session.publishToSource.mock.calls[0]?.[1] as
    | {
        type: string;
        payload: { shouldNotify: boolean; notification: { data: { workspaceId: string } } };
      }
    | undefined;
  expect(message?.type).toBe("agent_attention_required");
  return message?.payload;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("publishes committed rules only to subscribed clients that opted into the field", () => {
    const { server } = createServer();
    const legacy = connectClient(server, null);
    const capable = connectClient(server, null, { replyRuleNotifications: true });
    const config = {
      replyRules: [{ source: "^No news\\.$", flags: "i" }],
    };

    asInternals<WebSocketServerInternals>(server).broadcastDaemonConfigChanged.call(server, config);

    const connections = asInternals<{
      sessions: Map<object, { session: { publishToSource: ReturnType<typeof vi.fn> } }>;
    }>(server).sessions;
    const legacyMessage = connections.get(legacy)?.session.publishToSource.mock.calls[0]?.[1];
    const capableMessage = connections.get(capable)?.session.publishToSource.mock.calls[0]?.[1];

    expect(legacyMessage).toMatchObject({
      type: "status",
      payload: { status: "daemon_config_changed" },
    });
    expect(legacyMessage.payload.config).not.toHaveProperty("replyRules");
    expect(capableMessage).toMatchObject({
      type: "status",
      payload: { status: "daemon_config_changed", config: { replyRules: config.replyRules } },
    });
  });

  it("suppresses a matching complete subject for local attention", async () => {
    const matcher = ReplyRuleMatcher.compile([{ source: "^No news\\.$", flags: "i" }]);
    const rules = [{ source: "^No news\\.$", flags: "i" }];
    const workspaceIds = ["workspace-1", "workspace-2"];
    const workspaces = new Map(
      workspaceIds.map((workspaceId) => [
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "project-1",
          cwd: "/tmp/shared-workspace",
          kind: "directory",
          displayName: "Project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    );
    const workspaceRegistry = createStub<WorkspaceRegistry>({
      get: vi.fn(async (workspaceId) => workspaces.get(workspaceId) ?? null),
    });
    const { server, pushNotifications } = createServer(
      {
        getAgent: vi.fn((agentId: string) => ({
          config: { title: null },
          cwd: "/tmp/shared-workspace",
          workspaceId: agentId === "agent-2" ? "workspace-2" : "workspace-1",
          pendingPermissions: new Map(),
        })),
      },
      workspaceRegistry,
      {
        getReplyRules: () => rules,
        matchesReplyRules: (subject: Parameters<typeof matcher.matches>[0]) =>
          matcher.matches(subject),
      },
    );
    const ws = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: null,
      lastActivityAt: new Date(),
    });

    for (const agentId of ["agent-1", "agent-2"]) {
      await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId,
        provider: "claude",
        reason: "finished",
        completionSubject: {
          turnId: `turn-${agentId}`,
          text: "No news.",
          completeness: "complete",
        },
      });
    }

    const events = ws.send.mock.calls.map(([raw]) => {
      expect(typeof raw).toBe("string");
      if (typeof raw !== "string") throw new Error("Expected string WebSocket frame");
      return JSON.parse(raw).message.payload.event;
    });
    expect(
      events.map((event) => [
        event.shouldNotify,
        event.notification.data.workspaceId,
        event.notification.data.agentId,
      ]),
    ).toEqual([
      [false, "workspace-1", "agent-1"],
      [false, "workspace-2", "agent-2"],
    ]);
    expect(workspaceRegistry.get).toHaveBeenCalledWith("workspace-1");
    expect(workspaceRegistry.get).toHaveBeenCalledWith("workspace-2");
    expect(pushNotifications.sent).toEqual([]);
  });

  it("suppresses a matching complete subject for push when no client is present", async () => {
    const matcher = ReplyRuleMatcher.compile([{ source: "^No news\\.$", flags: "i" }]);
    const { server, pushNotifications } = createServer(undefined, undefined, {
      getReplyRules: () => [{ source: "^No news\\.$", flags: "i" }],
      matchesReplyRules: (subject: Parameters<typeof matcher.matches>[0]) =>
        matcher.matches(subject),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      completionSubject: {
        turnId: "turn-1",
        text: "No news.",
        completeness: "complete",
      },
    });

    expect(pushNotifications.sent).toEqual([]);
  });

  it.each(["permission", "error"] as const)(
    "does not consult reply rules for %s attention",
    async (reason) => {
      const matcher = vi.fn(() => true);
      const { server } = createServer(undefined, undefined, {
        getReplyRules: () => [{ source: ".*", flags: "" }],
        matchesReplyRules: matcher,
      });
      const ws = connectClient(server, {
        deviceType: "web",
        appVisible: false,
        focusedAgentId: null,
        lastActivityAt: new Date(),
      });

      await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId: "agent-1",
        provider: "claude",
        reason,
        completionSubject: {
          turnId: "turn-1",
          text: "matched",
          completeness: "complete",
        },
      });

      expect(matcher).not.toHaveBeenCalled();
      expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(true);
    },
  );

  it("reads the current rule matcher after asynchronous notification lookups", async () => {
    let resolveWorkspace: (workspace: null) => void = () => undefined;
    const workspaceRegistry = createStub<WorkspaceRegistry>({
      get: vi.fn(
        () =>
          new Promise<null>((resolve) => {
            resolveWorkspace = resolve;
          }),
      ),
    });
    let rules: Array<{ source: string; flags: string }> = [];
    let matcher = ReplyRuleMatcher.compile(rules);
    const store = {
      getReplyRules: () => rules,
      matchesReplyRules: (subject: Parameters<typeof matcher.matches>[0]) =>
        matcher.matches(subject),
    };
    const { server, pushNotifications } = createServer(undefined, workspaceRegistry, store);
    const decision = asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      completionSubject: {
        turnId: "turn-1",
        text: "No news.",
        completeness: "complete",
      },
    });
    await vi.waitFor(() => expect(workspaceRegistry.get).toHaveBeenCalledWith(WORKSPACE_ID));

    rules = [{ source: "^No news\\.$", flags: "i" }];
    matcher = ReplyRuleMatcher.compile(rules);
    resolveWorkspace(null);
    await decision;

    expect(pushNotifications.sent).toEqual([]);
  });

  it("does not fall back to latest assistant text when the completion subject is missing", async () => {
    const matcher = ReplyRuleMatcher.compile([{ source: "^No news\\.$", flags: "i" }]);
    const { server, pushNotifications, logger } = createServer(
      { getLastAssistantMessage: vi.fn(async () => "No news.") },
      undefined,
      {
        getReplyRules: () => [{ source: "^No news\\.$", flags: "i" }],
        matchesReplyRules: (subject: Parameters<typeof matcher.matches>[0]) =>
          matcher.matches(subject),
      },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reply_rule_match_fail_open", reason: "missing_subject" }),
      "Reply-rule evaluation failed open",
    );
    const serializedLogs = JSON.stringify(logger.info.mock.calls);
    expect(serializedLogs).not.toContain("No news.");
    expect(serializedLogs).not.toContain("^No news");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("does not send a muted push when no client is present", async () => {
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: WORKSPACE_ID,
      projectId: "project-1",
      cwd: "/tmp/shared-workspace",
      kind: "directory",
      displayName: "Project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      notifications: "off",
    });
    const workspaceRegistry = createStub<WorkspaceRegistry>({
      get: vi.fn(async (workspaceId) => (workspaceId === WORKSPACE_ID ? workspace : null)),
    });
    const matcher = vi.fn(() => true);
    const { server, pushNotifications } = createServer(undefined, workspaceRegistry, {
      getReplyRules: () => [{ source: ".*", flags: "" }],
      matchesReplyRules: matcher,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention.call(server, {
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      completionSubject: {
        turnId: "turn-1",
        text: "matched",
        completeness: "complete",
      },
    });

    expect(workspaceRegistry.get).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(matcher).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toEqual([]);
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it.each(["finished", "permission"] as const)(
    "reads current workspace mute after assistant lookup for %s attention and preserves source events",
    async (reason) => {
      let resolveAssistantMessage: (message: string | null) => void = () => undefined;
      const assistantMessage = new Promise<string | null>((resolve) => {
        resolveAssistantMessage = resolve;
      });
      const agent = { workspaceId: WORKSPACE_ID, pendingPermissions: new Map() };
      const workspace = createPersistedWorkspaceRecord({
        workspaceId: WORKSPACE_ID,
        projectId: "project-1",
        cwd: "/tmp/shared-workspace",
        kind: "directory",
        displayName: "Project",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        notifications: "on",
      });
      const workspaces = new Map<string, PersistedWorkspaceRecord>([[WORKSPACE_ID, workspace]]);
      const workspaceRegistry = createStub<WorkspaceRegistry>({
        get: vi.fn(async (workspaceId) => workspaces.get(workspaceId) ?? null),
      });
      const getLastAssistantMessage = vi.fn(() => assistantMessage);
      const { server, pushNotifications } = createServer(
        {
          getAgent: vi.fn(() => agent),
          getLastAssistantMessage,
        },
        workspaceRegistry,
      );
      const activity = {
        deviceType: "web" as const,
        focusedAgentId: null,
        lastActivityAt: new Date(),
        appVisible: false,
      };
      let resolveSubscription: (subscribed: boolean) => void = () => undefined;
      const subscription = new Promise<boolean>((resolve) => {
        resolveSubscription = resolve;
      });
      const routedWorkspaceIds: Array<string | undefined> = [];
      const legacyWs = connectClient(server, activity, {
        subscribe: async (routedAgent) => {
          routedWorkspaceIds.push(routedAgent.workspaceId);
          return subscription;
        },
      });
      const secondLegacyWs = connectClient(server, activity, {
        subscribe: async (routedAgent) => {
          routedWorkspaceIds.push(routedAgent.workspaceId);
          return true;
        },
      });
      const modernWs = connectClient(server, activity, { modern: true });
      const broadcast = asInternals<WebSocketServerInternals>(server).broadcastAgentAttention;
      const pendingBroadcast = broadcast.call(server, {
        agentId: "agent-1",
        provider: "claude",
        reason,
      });

      await vi.waitFor(() => expect(routedWorkspaceIds).toHaveLength(1));
      agent.workspaceId = "workspace-on";
      resolveSubscription(true);
      await vi.waitFor(() => expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1"));
      // Recipient routing and the payload use the captured identity; policy is read at decision time.
      workspaces.set(WORKSPACE_ID, { ...workspace, notifications: "off" });
      resolveAssistantMessage("Done.");
      await pendingBroadcast;

      expect(workspaceRegistry.get).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(pushNotifications.sent).toEqual([]);
      const legacyPayload = readAttentionRequiredMessage(legacyWs);
      const secondLegacyPayload = readAttentionRequiredMessage(secondLegacyWs);
      const modernPayload = readModernAttentionPayload(server, modernWs);
      expect(routedWorkspaceIds).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
      expect(legacyPayload.shouldNotify).toBe(false);
      expect(legacyPayload.notification.data.workspaceId).toBe(WORKSPACE_ID);
      expect(secondLegacyPayload.notification.data.workspaceId).toBe(WORKSPACE_ID);
      expect(modernPayload?.shouldNotify).toBe(false);
      expect(modernPayload?.notification.data.workspaceId).toBe(WORKSPACE_ID);
    },
  );
});
