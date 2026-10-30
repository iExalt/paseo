import { describe, expect, it, vi } from "vitest";
import { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  asAgentManager,
  asAgentStorage,
  createProviderSnapshotManagerStub,
} from "../../test-utils/session-stubs.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import { SessionAuthorization } from "../../authorization/index.js";

describe("native Paseo tool catalog", () => {
  it("applies the provider policy after the browser host gate", () => {
    const deps = {
      agentManager: asAgentManager({}),
      agentStorage: asAgentStorage({}),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      browserToolsEnabled: true,
      browserToolsBroker: new BrowserToolsBroker({}),
      paseoToolPolicy: { disabledTools: ["list_agents", "browser_screenshot"] },
      logger: createTestLogger(),
    };

    const catalog = createPaseoToolCatalog(deps);
    expect(catalog.getTool("list_agents")).toBeUndefined();
    expect(catalog.getTool("browser_screenshot")).toBeUndefined();
    expect(catalog.getTool("browser_list_tabs")).toBeDefined();

    const withoutBrowserHost = createPaseoToolCatalog({
      ...deps,
      browserToolsEnabled: false,
      paseoToolPolicy: undefined,
    });
    expect(withoutBrowserHost.getTool("browser_list_tabs")).toBeUndefined();
    expect(withoutBrowserHost.getTool("list_agents")).toBeDefined();
  });

  it("keeps screenshot pixels in native image content and omits them from structured metadata", async () => {
    const browserToolsBroker = new BrowserToolsBroker({});
    const execute = vi.spyOn(browserToolsBroker, "execute").mockResolvedValue({
      requestId: "request-1",
      ok: true,
      result: {
        command: "screenshot",
        browserId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        width: 800,
        height: 600,
      },
    });
    const catalog = createPaseoToolCatalog({
      agentManager: asAgentManager({
        getAgent: () => ({
          id: "agent-1",
          cwd: "/workspace/project",
          workspaceId: "workspace-1",
        }),
      }),
      agentStorage: asAgentStorage({}),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      browserToolsEnabled: true,
      browserToolsBroker,
      callerAgentId: "agent-1",
      logger: createTestLogger(),
    });

    const result = await catalog.executeTool("browser_screenshot", {
      browserId: "11111111-1111-4111-8111-111111111111",
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        cwd: "/workspace/project",
        workspaceId: "workspace-1",
        command: {
          command: "screenshot",
          args: {
            browserId: "11111111-1111-4111-8111-111111111111",
            fullPage: false,
          },
        },
      }),
    );
    expect(result.content).toContainEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    expect(result.structuredContent).toEqual({
      ok: true,
      result: {
        command: "screenshot",
        browserId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png",
        width: 800,
        height: 600,
      },
      context: {
        agentId: "agent-1",
        cwd: "/workspace/project",
        workspaceId: "workspace-1",
        browserId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("enforces host permissions on daemon-wide notification rules", async () => {
    const getReplyRules = vi.fn(() => []);
    const patch = vi.fn();
    const catalog = createPaseoToolCatalog({
      agentManager: asAgentManager({}),
      agentStorage: asAgentStorage({}),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      daemonConfigStore: {
        get: () => ({ agentTools: { enabled: true }, providers: {} }),
        getReplyRules,
        patch,
      },
      replyRuleFilteringEnabled: true,
      hostAuthorization: new SessionAuthorization([]),
      logger: createTestLogger(),
    });

    await expect(catalog.executeTool("get_daemon_notification_rules", {})).rejects.toThrow(
      "This operation requires daemon.read host permission.",
    );
    await expect(
      catalog.executeTool("set_daemon_notification_rules", { replyRules: [] }),
    ).rejects.toThrow("This operation requires daemon.manage host permission.");
    expect(getReplyRules).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("allows authorized host reads and mutations of daemon-wide notification rules", async () => {
    let currentRules: Array<{ source: string; flags: string }> = [];
    const getReplyRules = vi.fn(() => currentRules);
    const patch = vi.fn(async (input: { replyRules: Array<{ source: string; flags: string }> }) => {
      await Promise.resolve();
      currentRules = input.replyRules;
    });
    const catalog = createPaseoToolCatalog({
      agentManager: asAgentManager({}),
      agentStorage: asAgentStorage({}),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      daemonConfigStore: {
        get: () => ({ agentTools: { enabled: true }, providers: {} }),
        getReplyRules,
        patch,
      },
      replyRuleFilteringEnabled: true,
      hostAuthorization: new SessionAuthorization(["daemon.read", "daemon.manage"]),
      logger: createTestLogger(),
    });

    await expect(catalog.executeTool("get_daemon_notification_rules", {})).resolves.toMatchObject({
      structuredContent: { replyRules: [] },
    });
    await expect(
      catalog.executeTool("set_daemon_notification_rules", {
        replyRules: [{ source: "hello", flags: "i" }],
      }),
    ).resolves.toMatchObject({
      structuredContent: { replyRules: [{ source: "hello", flags: "i" }] },
    });
    expect(patch).toHaveBeenCalledWith({ replyRules: [{ source: "hello", flags: "i" }] });
    await expect(catalog.executeTool("clear_daemon_notification_rules", {})).resolves.toMatchObject(
      {
        structuredContent: { replyRules: [] },
      },
    );
    expect(currentRules).toEqual([]);

    patch.mockRejectedValueOnce(new Error("config write failed"));
    await expect(
      catalog.executeTool("set_daemon_notification_rules", { replyRules: [] }),
    ).rejects.toThrow("config write failed");
    patch.mockRejectedValueOnce(new Error("config write failed"));
    await expect(catalog.executeTool("clear_daemon_notification_rules", {})).rejects.toThrow(
      "config write failed",
    );
  });
});
