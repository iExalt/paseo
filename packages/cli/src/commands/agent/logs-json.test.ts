import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { connectToDaemon } from "../../utils/client.js";
import { runPaseoCli, startTestDaemon } from "../../../tests/helpers/test-daemon.js";

describe("paseo logs JSON output", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let agentId: string;
  let host: string;
  let ownedCompileCacheDir: string | null = null;
  let testEnv: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    const compileCacheDir =
      process.env.NODE_COMPILE_CACHE ||
      (ownedCompileCacheDir = await mkdtemp(join(tmpdir(), "paseo-logs-json-cache-")));
    testEnv = {
      NODE_COMPILE_CACHE: compileCacheDir,
      PASEO_DEFER_TERMINAL_WORKER_LAUNCH: "1",
      PASEO_DISABLE_BUILTIN_PLUGINS: "1",
    };
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
      env: testEnv,
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
    if (ownedCompileCacheDir) {
      await rm(ownedCompileCacheDir, { recursive: true, force: true });
    }
  });

  it.concurrent.each([
    { label: "top-level --json", args: ["logs", "--json"] },
    { label: "agent logs --json", args: ["agent", "logs", "--json"] },
    { label: "--format json alias", args: ["logs", "--format", "json"] },
  ])(
    "prints JSON through $label",
    async ({ args }) => {
      const result = await runPaseoCli(daemon, [...args, agentId, "--host", host], {
        env: testEnv,
      });
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
