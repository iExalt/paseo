// Process fixture: real daemon, storage and Codex adapter; deterministic native transport.
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { CodexAppServerAgentSession } from "../agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "../agent/providers/codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

const root = process.argv[2];
if (!root || !process.send) throw new Error("An isolated root and IPC parent are required");
await mkdir(join(root, "static"), { recursive: true });
function session(config: AgentSessionConfig, handle: AgentPersistenceHandle | null) {
  const server = createFakeCodexAppServer({
    "thread/read": () => ({ thread: { id: "thread-1", turns: [] } }),
    "thread/backgroundTerminals/list": () => ({ data: [], nextCursor: null }),
  });
  return new (class extends CodexAppServerAgentSession {
    override async startTurn(...args: Parameters<CodexAppServerAgentSession["startTurn"]>) {
      const result = await super.startTurn(...args);
      await appendFile(
        join(root, "prompts.jsonl"),
        JSON.stringify({ prompt: args[0], thread: this.describePersistence()?.sessionId }) + "\n",
      );
      setImmediate(() => {
        server.startsTurn({ threadId: "thread-1", turnId: "native-turn" });
        if (String(args[0]) === "ask")
          server.child.stdout.write(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "native-turn",
                item: {
                  type: "agentMessage",
                  id: "saved-question",
                  delivery: "async",
                  questions: [{ title: "Which color?", options: ["Blue", "Green"] }],
                },
              },
            }) + "\n",
          );
        server.completeTurn();
      });
      return result;
    }
  })(config, handle, createTestLogger(), async () => server.child);
}
const probe = session({ provider: "codex", cwd: root }, null);
const client: AgentClient = {
  provider: "codex",
  capabilities: probe.capabilities,
  createSession: async (config) => session(config, null),
  resumeSession: async (handle, config) => session(config, handle),
  isAvailable: async () => true,
  fetchCatalog: async () => ({ models: [], modes: [] }),
};
const daemon = await createTestPaseoDaemon({
  paseoHomeRoot: root,
  staticDir: join(root, "static"),
  cleanup: false,
  resumeOnStartup: false,
  mcpEnabled: false,
  agentClients: { codex: client },
});
process.send({ port: daemon.port });
const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.on("message", (message) => {
  if (message === "stop") void stop();
});
process.once("disconnect", () => void stop());
