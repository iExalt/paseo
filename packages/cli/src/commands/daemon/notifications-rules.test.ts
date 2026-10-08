import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { createDaemonCommand } from "./index.js";
import {
  daemonNotificationRulesCommand,
  runGetNotificationRulesCommand,
  runSetNotificationRulesCommand,
} from "./notifications-rules.js";

const getDaemonNotificationRules = vi.fn(async () => ({
  requestId: "get-1",
  replyRules: [{ source: "^No news\\.$", flags: "u" }],
}));
const setDaemonNotificationRules = vi.fn(
  async (replyRules: Array<{ source: string; flags: string }>) => ({
    requestId: "set-1",
    replyRules,
  }),
);
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getDaemonNotificationRules,
    setDaemonNotificationRules,
    close,
  })),
}));

describe("daemon notification rules CLI", () => {
  beforeEach(() => {
    getDaemonNotificationRules.mockClear();
    setDaemonNotificationRules.mockClear();
    close.mockClear();
    vi.mocked(connectToDaemon).mockClear();
  });

  it("uses the dotted RPCs for get, escaped-JSON set, and clear", async () => {
    const command = createDaemonCommand();
    const escapedRuleJson = String.raw`[{"source":"^No news\\.$","flags":"u"}]`;

    await command.parseAsync(["notifications", "rules", "get", "--json"], { from: "user" });
    await command.parseAsync(["notifications", "rules", "set", escapedRuleJson, "--json"], {
      from: "user",
    });
    await command.parseAsync(["notifications", "rules", "clear", "--json"], { from: "user" });

    expect(getDaemonNotificationRules).toHaveBeenCalledOnce();
    expect(setDaemonNotificationRules).toHaveBeenNthCalledWith(1, [
      { source: "^No news\\.$", flags: "u" },
    ]);
    expect(setDaemonNotificationRules).toHaveBeenNthCalledWith(2, []);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("documents the shell-safe escaped-regex JSON input", () => {
    const set = daemonNotificationRulesCommand()
      .commands.find((command) => command.name() === "rules")
      ?.commands.find((command) => command.name() === "set");

    expect(set?.helpInformation()).toContain("No news\\\\.$");
  });

  it("rejects malformed JSON before connecting and maps unsupported hosts", async () => {
    const options = {
      daemonTarget: { kind: "instance" as const, home: "/tmp/notification-rules-test" },
      json: true,
    };

    await expect(runSetNotificationRulesCommand("not-json", options)).rejects.toMatchObject({
      code: "INVALID_REPLY_RULES_JSON",
    });
    expect(connectToDaemon).not.toHaveBeenCalled();

    getDaemonNotificationRules.mockRejectedValueOnce(
      new Error("Update the host to manage daemon-wide notification rules."),
    );
    await expect(runGetNotificationRulesCommand(options)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
