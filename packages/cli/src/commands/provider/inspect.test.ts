import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  ProviderInspectResultSchema,
  ServerInfoStatusPayloadSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { parseProviderFeatureValues, runProviderInspectCommand } from "./inspect.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createOldDaemonClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "provider-inspect-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: {},
    }),
  );
  const inspectProvider = vi.spyOn(client, "inspectProvider");
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, inspectProvider };
}

function createAgentSnapshot(agentId: string) {
  return AgentSnapshotPayloadSchema.parse({
    id: agentId,
    provider: "claude",
    cwd: "/workspace/caller",
    model: "claude-test-model",
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
}

describe("provider inspect feature settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("combines primitive flags with arbitrary JSON values", () => {
    expect(
      parseProviderFeatureValues(["fast_mode=false"], '{"complex":{"rank":2},"items":[1]}'),
    ).toEqual({ fast_mode: false, complex: { rank: 2 }, items: [1] });
  });

  it("preserves an explicitly empty JSON feature object", () => {
    expect(parseProviderFeatureValues(undefined, "{}")).toEqual({});
  });

  it("rejects duplicate feature IDs across JSON and primitive flags", () => {
    expect(() => parseProviderFeatureValues(["fast_mode=true"], '{"fast_mode":false}')).toThrow(
      "Feature specified more than once: fast_mode",
    );
  });

  it.each(["", "[]", "null", "{", '"string"'])(
    "rejects non-object or malformed JSON %s",
    (value) => {
      expect(() => parseProviderFeatureValues(undefined, value)).toThrow(
        "--features-json must contain a JSON object.",
      );
    },
  );

  it("rejects an old daemon before sending provider.inspect", async () => {
    const { client, inspectProvider } = createOldDaemonClient();

    await expect(
      runProviderInspectCommand("claude", { daemonTarget, cwd: "/workspace" }, new Command()),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });

    expect(inspectProvider).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses a matching PASEO_AGENT_ID as caller scope when cwd is omitted", async () => {
    const agentId = "00000000-0000-4000-8000-000000000002";
    const originalCallerId = process.env.PASEO_AGENT_ID;
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "provider-inspect-caller-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-test",
        features: { providerInspect: true },
      }),
    );
    vi.spyOn(client, "fetchAgent").mockResolvedValue({
      agent: createAgentSnapshot(agentId),
      project: null,
    });
    const inspectProvider = vi.spyOn(client, "inspectProvider").mockResolvedValue(
      ProviderInspectResultSchema.parse({
        provider: "claude",
        enabled: true,
        status: "available",
        selectedModel: null,
        features: [],
      }),
    );
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    process.env.PASEO_AGENT_ID = agentId;

    try {
      await runProviderInspectCommand("claude", { daemonTarget }, new Command());
      expect(inspectProvider).toHaveBeenCalledWith({
        provider: "claude",
        callerAgentId: agentId,
        settings: {},
      });
    } finally {
      if (originalCallerId === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = originalCallerId;
    }
  });
});
