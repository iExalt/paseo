import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentHistoryResponseMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runCloseCommand } from "./close.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

function historyPage(agentIds: string[], nextCursor: string | null = null) {
  return FetchAgentHistoryResponseMessageSchema.parse({
    type: "fetch_agent_history_response",
    payload: {
      requestId: "history-request",
      entries: agentIds.map((id) => ({
        agent: AgentSnapshotPayloadSchema.parse({
          id,
          provider: "codex",
          cwd: "/workspace",
          model: "gpt-5.4",
          createdAt: "2026-10-10T00:00:00.000Z",
          updatedAt: "2026-10-10T00:00:00.000Z",
          lastUserMessageAt: null,
          status: "closed",
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
          title: id,
          labels: {},
        }),
        project: {
          projectKey: "project:/workspace",
          projectName: "Workspace",
          checkout: {
            cwd: "/workspace",
            isGit: false,
            currentBranch: null,
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          },
        },
      })),
      pageInfo: { nextCursor, prevCursor: null, hasMore: nextCursor !== null },
    },
  }).payload;
}

function createClient(pages: Array<ReturnType<typeof historyPage>>, agentClose: boolean) {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "cli-close-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: agentClose ? { agentClose: true } : {},
    }),
  );
  const fetchAgentHistory = vi
    .spyOn(client, "fetchAgentHistory")
    .mockImplementation(async (options) => {
      const index = options?.page?.cursor ? Number(options.page.cursor) : 0;
      const payload = pages[index];
      if (!payload) throw new Error(`Unexpected history page ${index}`);
      return payload;
    });
  const closeAgent = vi.spyOn(client, "closeAgent").mockResolvedValue();
  const close = vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, fetchAgentHistory, closeAgent, close };
}

describe("runCloseCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes an agent found by a unique prefix across history pages", async () => {
    const client = createClient(
      [historyPage(["other-agent"], "1"), historyPage(["agent-2"])],
      true,
    );

    await expect(
      runCloseCommand("agent-", { daemonTarget }, new Command("close")),
    ).resolves.toMatchObject({
      data: { agentId: "agent-2", status: "closed" },
    });
    expect(client.fetchAgentHistory).toHaveBeenCalledTimes(2);
    expect(client.closeAgent).toHaveBeenCalledWith("agent-2");
  });

  it("prefers an exact ID over a longer ID with the same prefix", async () => {
    const client = createClient([historyPage(["agent-1", "agent-10"])], true);

    await runCloseCommand("agent-1", { daemonTarget }, new Command("close"));

    expect(client.closeAgent).toHaveBeenCalledWith("agent-1");
  });

  it("rejects an ambiguous prefix without closing either match", async () => {
    const client = createClient([historyPage(["agent-10", "agent-11"])], true);

    await expect(
      runCloseCommand("agent-1", { daemonTarget }, new Command("close")),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_AGENT_ID",
      details: "Matches: agent-10, agent-11",
    });
    expect(client.closeAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty ID before connecting to the daemon", async () => {
    await expect(
      runCloseCommand(" \t ", { daemonTarget }, new Command("close")),
    ).rejects.toMatchObject({ code: "MISSING_AGENT_ID" });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });

  it("reports a missing ID without closing an agent", async () => {
    const client = createClient([historyPage(["other-agent"])], true);

    await expect(
      runCloseCommand("missing", { daemonTarget }, new Command("close")),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(client.closeAgent).not.toHaveBeenCalled();
  });

  it("propagates a rejected close response", async () => {
    const client = createClient([historyPage(["agent-1"])], true);
    client.closeAgent.mockRejectedValue(new Error("provider close failed"));

    await expect(
      runCloseCommand("agent-1", { daemonTarget }, new Command("close")),
    ).rejects.toThrow("provider close failed");
  });

  it("requires the daemon feature before reading history or sending a close", async () => {
    const client = createClient([historyPage(["agent-1"])], false);

    await expect(
      runCloseCommand("agent-1", { daemonTarget }, new Command("close")),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
    });
    expect(client.fetchAgentHistory).not.toHaveBeenCalled();
    expect(client.closeAgent).not.toHaveBeenCalled();
  });
});
