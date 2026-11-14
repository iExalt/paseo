import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

// The update path asks a daemon to stop only when idle. A daemon mid-turn must answer
// `shutdown_declined` and keep the turn; the same request after the turn ends is accepted.
test("an idle-only shutdown waits for the running turn", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: async () => {
        started.resolve();
        await release.promise;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.shutdownIfIdle).toBe(true);
    const agent = await client.createAgent({
      provider: "codex",
      cwd: daemon.paseoHome,
      title: "Busy",
      modeId: "full-access",
    });
    await client.sendMessage(agent.id, "Long task");
    await started.promise;

    await expect(
      client.shutdownServer({ onlyIfIdle: true, keepTerminals: true }),
    ).resolves.toMatchObject({ status: "shutdown_declined", reason: "busy" });

    release.resolve();
    const finished = await client.waitForFinish(agent.id, 20_000);
    expect(finished.status).toBe("idle");
    await expect(
      client.shutdownServer({ onlyIfIdle: true, keepTerminals: true }),
    ).resolves.toMatchObject({ status: "shutdown_requested" });
  } finally {
    release.resolve();
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);
