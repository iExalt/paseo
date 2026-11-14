import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runLsCommand } from "./ls.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "daemon.test:12345" };

describe("permit ls capability gate", () => {
  beforeEach(() => vi.mocked(connectToDaemon).mockReset());

  it("rejects an old daemon before sending permission.list", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "permit-list-gate-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: {},
      }),
    );
    const listPermissions = vi.spyOn(client, "listPendingAgentPermissions");
    const close = vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);

    await expect(runLsCommand({ daemonTarget }, new Command())).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });

    expect(listPermissions).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
