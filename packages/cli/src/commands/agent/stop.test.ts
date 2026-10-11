import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentsResponseMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runStopCommand } from "./stop.js";

const daemonTarget = { kind: "endpoint" as const, host: "daemon.test:12345" };
const agentId = "agent-running";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

function createClient(agentCancelOutcome: boolean) {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "cli-stop-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: agentCancelOutcome ? { agentCancelOutcome: true } : {},
    }),
  );
  const fetchAgents = vi.spyOn(client, "fetchAgents").mockResolvedValue(
    FetchAgentsResponseMessageSchema.parse({
      type: "fetch_agents_response",
      payload: {
        requestId: "fetch-agents",
        entries: [],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      },
    }).payload,
  );
  vi.spyOn(client, "fetchAgent").mockResolvedValue({
    agent: AgentSnapshotPayloadSchema.parse({
      id: agentId,
      provider: "codex",
      cwd: "/workspace",
      model: "gpt-5.4",
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "running",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: agentId,
      labels: {},
    }),
    project: null,
  });
  const cancelAgent = vi.spyOn(client, "cancelAgent").mockResolvedValue(undefined);
  const close = vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, cancelAgent, close, fetchAgents };
}

describe("runStopCommand cancellation outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects daemons that do not advertise acknowledged cancellation before fetching agents", async () => {
    const client = createClient(false);

    await expect(
      runStopCommand(agentId, { daemonTarget }, new Command("stop")),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_DAEMON_FEATURE" });
    expect(client.fetchAgents).not.toHaveBeenCalled();
    expect(client.cancelAgent).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not report success when an advertised daemon omits the cancellation outcome", async () => {
    const client = createClient(true);
    expect(client.client.getLastServerInfoMessage()?.features?.agentCancelOutcome).toBe(true);

    await expect(
      runStopCommand(agentId, { daemonTarget }, new Command("stop")),
    ).rejects.toMatchObject({
      code: "STOP_AGENT_FAILED",
      message: expect.stringContaining("did not report whether the agent run was cancelled"),
    });
    expect(client.cancelAgent).toHaveBeenCalledWith(agentId);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
