import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

// Opt in to the same workflow with the installed providers instead of test clients.
const real = process.env.PASEO_ARCHIVE_REAL === "1";
test.each(["codex", "claude"] as const)(
  "archived %s history remains archived across CLI discovery",
  async (provider) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "archive-discovery-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: real
        ? {
            [provider]:
              provider === "codex"
                ? new CodexAppServerAgentClient(logger)
                : new ClaudeAgentClient({ logger }),
          }
        : createTestAgentClients(),
      pluginsEnabled: false,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    // The requests `paseo agent ls`, `paseo agent status` and `paseo agent archive` send.
    const list = async (includeArchived: boolean) =>
      (await client.fetchAgents({ filter: { includeArchived } })).entries
        .map((entry) => entry.agent)
        .filter((agent) => agent.cwd === cwd);
    const status = async (agentId: string) => (await client.getAgentStatus(agentId)).snapshot;
    try {
      await client.connect();
      const realModel = provider === "codex" ? "gpt-5.6-sol" : "haiku";
      const agent = await client.createAgent({
        config: {
          provider,
          cwd,
          model: real ? realModel : undefined,
          modeId: provider === "codex" ? "full-access" : "bypassPermissions",
        },
      });
      await daemon.daemon.agentManager.runAgent(
        agent.id,
        "Reply with ARCHIVE_OK. Do not use tools.",
      );
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
      await client.archiveAgent(agent.id);
      const archivedAt = (await status(agent.id)).archivedAt;
      expect(archivedAt).toEqual(expect.any(String));
      expect((await list(false)).map((item) => item.id)).not.toContain(agent.id);

      const timeline = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      expect(timeline.entries.length).toBeGreaterThan(0);
      expect.soft((await status(agent.id)).archivedAt).toBe(archivedAt);
      expect.soft((await list(false)).map((item) => item.id)).not.toContain(agent.id);
      expect
        .soft((await list(true)).find((item) => item.id === agent.id)?.archivedAt)
        .toBe(archivedAt);

      await client.refreshAgent(agent.id);
      expect((await status(agent.id)).archivedAt).toBeNull();
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
    } finally {
      await client.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
