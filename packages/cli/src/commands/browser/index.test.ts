import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { BrowserCommandExecuteResponseSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  AgentSnapshotPayloadSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { createCli } from "../../cli.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

describe("registered browser CLI commands", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends new-tab with an empty args object when its optional URL is omitted", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "browser-new-tab-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: { browserCommandCli: true },
      }),
    );
    const executeBrowserCommand = vi.spyOn(client, "executeBrowserCommand").mockResolvedValue(
      BrowserCommandExecuteResponseSchema.parse({
        type: "browser.command.execute.response",
        payload: {
          requestId: "browser-new-tab",
          result: {
            requestId: "browser-new-tab",
            ok: true,
            result: {
              command: "new_tab",
              browserId: "11111111-1111-4111-8111-111111111111",
              workspaceId: "workspace-1",
              url: "about:blank",
            },
          },
          context: { agentId: "agent-1", workspaceId: "workspace-1" },
        },
      }).payload,
    );
    const agent = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/workspace",
      model: null,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Caller",
      labels: {},
    });
    const fetchAgent = vi.spyOn(client, "fetchAgent").mockImplementation(async (input) => {
      const agentId = typeof input === "string" ? input : input.agentId;
      return agentId === "agent-1" ? { agent, project: null } : null;
    });
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCli().parseAsync([
      "node",
      "paseo",
      "browser",
      "new-tab",
      "--agent",
      "agent-1",
      "--workspace",
      "workspace-1",
      "--json",
      "--host",
      "daemon.test:12345",
    ]);

    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(executeBrowserCommand).toHaveBeenCalledWith(
      {
        command: { command: "new_tab", args: {} },
        agentId: "agent-1",
        workspaceId: "workspace-1",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stdout).toHaveBeenCalled();
  });
});
