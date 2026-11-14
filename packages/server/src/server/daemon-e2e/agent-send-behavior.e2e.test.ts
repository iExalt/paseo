import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

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
