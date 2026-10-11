import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runAgentActivityCommand } from "./activity.js";
import { runAgentQueryCommand } from "./query.js";
import { runAgentStatusCommand } from "./status.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "daemon.test:12345" };

function createOldDaemonClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "agent-query-gate-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: {},
    }),
  );
  const query = vi.spyOn(client, "queryAgentDirectory");
  const status = vi.spyOn(client, "getAgentStatus");
  const activity = vi.spyOn(client, "getAgentActivity");
  vi.spyOn(client, "close").mockResolvedValue();
  return { client, query, status, activity };
}

describe("agent query command gates", () => {
  beforeEach(() => vi.mocked(connectToDaemon).mockReset());

  it("uses the 48-hour/50-result defaults and omits an empty status filter", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "agent-query-defaults-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: { agentDirectoryQuery: true },
      }),
    );
    const query = vi.spyOn(client, "queryAgentDirectory").mockResolvedValue([]);
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValue(client);

    await runAgentQueryCommand({ daemonTarget, callerAgent: "caller" }, new Command());
    await runAgentQueryCommand({ daemonTarget, callerAgent: "caller", status: [] }, new Command());

    expect(query).toHaveBeenNthCalledWith(1, {
      callerAgentId: "caller",
      sinceHours: 48,
      limit: 50,
    });
    expect(query).toHaveBeenNthCalledWith(2, {
      callerAgentId: "caller",
      sinceHours: 48,
      limit: 50,
    });
  });

  it("gates each new command before its corresponding RPC", async () => {
    const { client, query, status, activity } = createOldDaemonClient();
    for (const invoke of [
      () => runAgentQueryCommand({ daemonTarget, callerAgent: "caller" }, new Command()),
      () => runAgentStatusCommand("agent-1", { daemonTarget }, new Command()),
      () => runAgentActivityCommand("agent-1", { daemonTarget }, new Command()),
    ]) {
      vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
      await expect(invoke()).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    }

    expect(query).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it("validates list constraints before connecting", async () => {
    for (const options of [
      { limit: "0" },
      { limit: "201" },
      { sinceHours: "0" },
      { sinceHours: "721" },
      { status: ["unknown"] },
    ]) {
      await expect(
        runAgentQueryCommand({ daemonTarget, ...options }, new Command()),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_QUERY" });
    }
    expect(connectToDaemon).not.toHaveBeenCalled();
  });
});
