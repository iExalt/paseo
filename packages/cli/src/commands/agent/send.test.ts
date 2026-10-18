import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import { addSendOptions, runSendCommand } from "./send.js";

const daemonTarget = { kind: "endpoint" as const, host: "daemon.test:12345" };

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));
vi.mock("../../utils/caller-agent.js", () => ({ resolveCallerAgentId: vi.fn(async () => null) }));

function createClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "cli-send-test",
    reconnect: { enabled: false },
  });
  const sendAgentMessage = vi.spyOn(client, "sendAgentMessage").mockResolvedValue({});
  const waitForFinish = vi.spyOn(client, "waitForFinish").mockResolvedValue({
    status: "idle",
    final: null,
    error: null,
    lastMessage: null,
  });
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { sendAgentMessage, waitForFinish };
}

function parseSend(args: string[]) {
  const command = addSendOptions(
    new Command("send").exitOverride().configureOutput({
      writeErr: () => {},
    }),
  );
  command.action(() => {});
  command.parse(args, { from: "user" });
  return command.opts();
}

describe("agent send --if-running", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("steers a running agent unless told otherwise, and only accepts known behaviors", () => {
    expect(parseSend(["agent-1", "hello"]).ifRunning).toBe("steer");
    expect(parseSend(["agent-1", "hello", "--if-running", "interrupt"]).ifRunning).toBe(
      "interrupt",
    );
    expect(() => parseSend(["agent-1", "hello", "--if-running", "later"])).toThrow();
  });

  it("waits for the message it sent, so a held message is not reported early", async () => {
    const { sendAgentMessage, waitForFinish } = createClient();

    await runSendCommand("agent-1", "hello", { daemonTarget, ifRunning: "steer" }, new Command());

    const sent = sendAgentMessage.mock.calls[0]![2]!;
    expect(sent).toMatchObject({ activeTurnBehavior: "steer", messageId: expect.any(String) });
    expect(waitForFinish).toHaveBeenCalledWith("agent-1", 600000, { messageId: sent.messageId });
  });
});
