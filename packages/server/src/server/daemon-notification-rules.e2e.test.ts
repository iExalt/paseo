import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runClearNotificationRulesCommand,
  runGetNotificationRulesCommand,
  runSetNotificationRulesCommand,
} from "../../../cli/src/commands/daemon/notifications-rules.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

test("CLI manages daemon notification rules through the authorized local daemon", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "paseo-daemon-notification-rules-"));
  const paseoHomeRoot = path.join(fixtureRoot, "home");
  const staticDir = path.join(fixtureRoot, "static");

  let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
  try {
    await mkdir(staticDir, { recursive: true });
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      listen: "127.0.0.1",
      listenPort: 0,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      cleanup: false,
    });
    const daemonTarget = {
      kind: "endpoint" as const,
      host: `127.0.0.1:${daemon.port}`,
    };
    const cliOptions = { daemonTarget, json: true };

    const initial = await runGetNotificationRulesCommand(cliOptions);
    expect(initial.data.replyRules).toEqual([]);

    const escapedRule = { source: "^No news\\.$", flags: "u" };
    const set = await runSetNotificationRulesCommand(JSON.stringify([escapedRule]), cliOptions);
    expect(set.data.replyRules).toEqual([escapedRule]);

    await expect(
      runSetNotificationRulesCommand(
        JSON.stringify([{ source: "^No news$", flags: "x" }]),
        cliOptions,
      ),
    ).rejects.toThrow();
    const retained = await runGetNotificationRulesCommand(cliOptions);
    expect(retained.data.replyRules).toEqual([escapedRule]);

    const clearedByCli = await runClearNotificationRulesCommand(cliOptions);
    expect(clearedByCli.data.replyRules).toEqual([]);
  } finally {
    try {
      await daemon?.close();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});
