import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { createCli } from "../../cli.js";
import { runSpeechSpeakCommand } from "./index.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

describe("registered speech CLI command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trims text, gates on daemon capability, and waits on the typed request", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "speech-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: { voiceSpeakCli: true },
      }),
    );
    const speakText = vi.spyOn(client, "speakText").mockResolvedValue({
      requestId: "speech-request",
      ok: true,
    });
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCli().parseAsync([
      "node",
      "paseo",
      "speech",
      "speak",
      "  hello there  ",
      "--agent",
      "agent-1",
      "--json",
      "--host",
      "daemon.test:12345",
    ]);

    expect(speakText).toHaveBeenCalledWith(
      { text: "hello there", callerAgentId: "agent-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
  });

  it("rejects speech when the connected daemon lacks the capability", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "speech-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: {},
      }),
    );
    const speakText = vi.spyOn(client, "speakText");
    const close = vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);

    await expect(
      runSpeechSpeakCommand(
        "hello",
        { daemonTarget: { kind: "endpoint", host: "daemon.test" } },
        new Command(),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    expect(speakText).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
