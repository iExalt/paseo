import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runProfileLsCommand } from "./index.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "profile-list-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: {},
    }),
  );
  const listProfiles = vi.spyOn(client, "listAgentProfiles").mockResolvedValue({
    requestId: "profile-list",
    profiles: [],
  });
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, listProfiles };
}

describe("runProfileLsCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an old daemon before sending profile.list", async () => {
    const { client, listProfiles } = createClient();

    await expect(runProfileLsCommand({ daemonTarget }, new Command())).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });

    expect(listProfiles).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
