import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

// The deterministic Codex provider cannot steer, so a steer is held like a queued message, and a
// prompt mentioning sleep runs a 250 ms shell call. A blocking send must report the turn its own
// message ran in, not the turn it was held behind.
test("waiting on a held send follows the message it sent", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({
      provider: "codex",
      cwd: daemon.paseoHome,
      title: "Held send",
      modeId: "full-access",
    });
    for (const behavior of ["steer", "queue"] as const) {
      await client.sendMessage(agent.id, "run sleep in the shell");
      const messageId = randomUUID();
      const dispatch = await client.sendAgentMessage(
        agent.id,
        "run sleep in the shell, then say 'state saved'",
        {
          activeTurnBehavior: behavior,
          messageId,
        },
      );
      expect(dispatch.disposition).toBe(behavior === "queue" ? "queued" : undefined);
      const state = await client.waitForFinish(agent.id, 20_000, { messageId });
      expect(state.status).toBe("idle");
      expect(state.lastMessage).toContain("state saved");
    }
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

// An agent's send waits two quiet seconds before dispatch, so the first turn stays open until the
// daemon logs the follow-up as held behind it.
test("a held send notifies its caller when its own turn finishes", async () => {
  const notifications: string[] = [];
  const firstTurn = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const daemon = await createTestPaseoDaemon({
    logger: pino(
      { level: "info" },
      {
        write: (line: string) => {
          if (line.includes('"agent.held_message.held"')) held.resolve();
        },
      },
    ),
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        if (String(prompt).includes('kind="agent-notification"'))
          notifications.push(String(prompt));
      },
      beforeTurnComplete: async (prompt) => {
        if (String(prompt).includes("First task")) await firstTurn.promise;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const create = (title: string) =>
      client.createAgent({
        provider: "codex",
        cwd: daemon.paseoHome,
        title,
        modeId: "full-access",
      });
    const caller = await create("Caller");
    const agent = await create("Held send");
    await client.sendMessage(agent.id, "First task");
    await client.sendAgentMessage(agent.id, "run sleep in the shell, then say 'state saved'", {
      sourceAgentId: caller.id,
      notifyOnFinish: true,
    });
    await held.promise;
    firstTurn.resolve();
    await expect.poll(() => notifications.length, { timeout: 20_000 }).toBe(1);
    expect(notifications[0]).toContain("state saved");
  } finally {
    firstTurn.resolve();
    await client.close();
    await daemon.close();
  }
}, 60_000);
