import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentsResponseMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runStopCommand } from "./stop.js";
import { render, withOutput } from "../../output/index.js";

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
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
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
  async function setTargets(client: ReturnType<typeof createClient>, ids: string[]) {
    const entry = await client.client.fetchAgent({ agentId });
    client.fetchAgents.mockResolvedValue({
      requestId: "bulk",
      entries: ids.map((id) => ({ ...entry!, agent: { ...entry!.agent, id } })),
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    });
  }

  it("renders every bulk outcome and preserves a failing exit through withOutput", async () => {
    const client = createClient(true);
    await setTargets(client, ["stopped", "failed", "idle"]);
    client.cancelAgent.mockImplementation(async (id) => {
      if (id === "failed") throw Object.assign(new Error("refused"), { code: "REFUSED" });
      return id === "stopped";
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const command = new Command("stop").option("--all").option("--json");
    command.setOptionValue("all", true).setOptionValue("json", true);

    await withOutput(runStopCommand)(undefined, { daemonTarget }, command);

    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
      stoppedCount: 1,
      agentIds: ["stopped"],
      results: [
        { agentId: "stopped", cancelled: true },
        { agentId: "failed", error: "refused" },
        { agentId: "idle", cancelled: false },
      ],
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(client.cancelAgent.mock.calls).toEqual([["stopped"], ["failed"], ["idle"]]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reports all failed targets in human output", async () => {
    const client = createClient(true);
    await setTargets(client, ["failed"]);
    client.cancelAgent.mockRejectedValue(new Error("refused"));
    const result = await runStopCommand(undefined, { daemonTarget, all: true }, new Command());

    expect(result.data).toEqual({
      stoppedCount: 0,
      agentIds: [],
      results: [{ agentId: "failed", error: "refused" }],
    });
    expect(render(result, { noColor: true })).toContain("Failed to stop agent failed: refused");
    expect(process.exitCode).toBe(1);
  });

  it("treats idle stop as a successful no-op", async () => {
    const client = createClient(true);
    client.cancelAgent.mockResolvedValue(false);
    const result = await runStopCommand(agentId, { daemonTarget }, new Command());

    expect(result.data).toEqual({ stoppedCount: 0, agentIds: [], success: false });
    expect(process.exitCode).toBeUndefined();
  });

  it("succeeds without mutations when bulk selection is empty", async () => {
    const client = createClient(true);
    const result = await runStopCommand(undefined, { daemonTarget, all: true }, new Command());

    expect(result.data).toEqual({ stoppedCount: 0, agentIds: [], results: [] });
    expect(client.cancelAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
