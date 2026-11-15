import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { connectToDaemon } from "../../utils/client.js";
import { runPaseoCli, startTestDaemon } from "../../../tests/helpers/test-daemon.js";

describe("paseo logs JSON output", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let agentId: string;
  let host: string;

  beforeAll(async () => {
    await mkdir(".artifacts", { recursive: true });
    const paseoHome = await mkdtemp(resolve(".artifacts/logs-json-home-"));
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify({
        agents: {
          providers: {
            claude: {
              command: {
                mode: "replace",
                argv: [process.execPath, "-e", 'console.log("2.1.302 (Claude Code)")', "--"],
              },
            },
          },
        },
      }),
    );
    daemon = await startTestDaemon({
      paseoHome,
      workDir: await mkdtemp(resolve(".artifacts/logs-json-work-")),
    });
    host = `127.0.0.1:${daemon.port}`;
    const client = await connectToDaemon({ target: { kind: "endpoint", host } });
    try {
      // Creating an idle agent needs no inference or external provider connection.
      const agent = await client.createAgent({
        provider: "claude",
        cwd: daemon.workDir,
        title: "JSON logs",
      });
      agentId = agent.id;
    } finally {
      await client.close();
    }
  }, 60_000);

  afterAll(async () => {
    await daemon?.stop();
  });

  it.each([
    { label: "top-level --json", args: ["logs", "--json"] },
    { label: "agent logs --json", args: ["agent", "logs", "--json"] },
    { label: "--format json alias", args: ["logs", "--format", "json"] },
  ])(
    "prints JSON through $label",
    async ({ args }) => {
      const result = await runPaseoCli(daemon, [...args, agentId, "--host", host]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        agentId,
        agent: expect.objectContaining({ id: agentId }),
        requestId: expect.any(String),
        epoch: expect.any(String),
        direction: "tail",
        projection: "projected",
        entries: [],
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        gap: false,
        reset: false,
        staleCursor: false,
        error: null,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
      });
    },
    30_000,
  );
});
