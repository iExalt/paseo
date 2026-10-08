import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runClearNotificationRulesCommand,
  runGetNotificationRulesCommand,
  runSetNotificationRulesCommand,
} from "../../../cli/src/commands/daemon/notifications-rules.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

test("CLI and MCP manage daemon notification rules through authorized transports", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "paseo-daemon-notification-rules-"));
  const paseoHomeRoot = path.join(fixtureRoot, "home");
  const staticDir = path.join(fixtureRoot, "static");

  let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
  const mcpClients: Client[] = [];
  try {
    await mkdir(staticDir, { recursive: true });
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      listen: "127.0.0.1",
      listenPort: 0,
      mcpEnabled: true,
      mcpDebug: false,
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

    const localCredential = (
      await readFile(path.join(daemon.paseoHome, "local-credential"), "utf8")
    ).trim();
    const agentCapability = daemon.daemon.agentManager.getMcpAuthToken();
    if (!agentCapability) throw new Error("Test daemon did not provide its agent capability");
    const endpoint = new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`);
    const connectMcp = async (token?: string) => {
      const client = new Client({ name: "notification-rules-test", version: "0.0.0" });
      mcpClients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          endpoint,
          token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {},
        ),
      );
      return client;
    };

    const anonymous = await connectMcp();
    const deniedAnonymous = await anonymous.callTool({
      name: "get_daemon_notification_rules",
      arguments: {},
    });
    expect(deniedAnonymous.isError).toBe(true);

    const agentClient = await connectMcp(agentCapability);
    const deniedAgent = await agentClient.callTool({
      name: "get_daemon_notification_rules",
      arguments: {},
    });
    expect(deniedAgent.isError).toBe(true);

    const owner = await connectMcp(localCredential);
    const read = await owner.callTool({
      name: "get_daemon_notification_rules",
      arguments: {},
    });
    expect(read.structuredContent).toEqual({ replyRules: [escapedRule] });
    const cleared = await owner.callTool({
      name: "clear_daemon_notification_rules",
      arguments: {},
    });
    expect(cleared.structuredContent).toEqual({ replyRules: [] });
    const restored = await owner.callTool({
      name: "set_daemon_notification_rules",
      arguments: { replyRules: [escapedRule] },
    });
    expect(restored.structuredContent).toEqual({ replyRules: [escapedRule] });

    const finalRules = await runGetNotificationRulesCommand(cliOptions);
    expect(finalRules.data.replyRules).toEqual([escapedRule]);
    const clearedByCli = await runClearNotificationRulesCommand(cliOptions);
    expect(clearedByCli.data.replyRules).toEqual([]);
  } finally {
    for (const client of mcpClients) await client.close().catch(() => undefined);
    try {
      await daemon?.close();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});
