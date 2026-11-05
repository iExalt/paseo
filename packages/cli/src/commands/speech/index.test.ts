import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
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
      "speech",
      "speak",
      "  hello there  ",
      "--agent",
      "agent-1",
      "--json",
      "--host",
      "daemon.test:12345",
    ]);

    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-1" });
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
