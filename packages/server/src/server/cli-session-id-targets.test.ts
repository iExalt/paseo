import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProviderSessionId } from "@getpaseo/protocol/agent-provider-session-id";
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runLocalPaseo(args: string[], home: string): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
      ...args,
    ],
    {
      cwd: home,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
        ),
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

// The journey the feature exists for: copy a session ID in the app, hand it to another agent, and
// have that agent's CLI reach the same Paseo agent through both resolution paths.
test("the copied session ID targets the same agent through the daemon and the CLI", async () => {
  const cliHome = await mkdtemp(join(tmpdir(), "paseo-session-id-cli-home-"));
  const ctx = await createDaemonTestContext();
  try {
    const created = await ctx.client.createAgent({
      provider: "codex",
      cwd: ctx.daemon.paseoHome,
      title: "session id target",
    });
    const listed = (await ctx.client.fetchAgents()).entries.map((entry) => entry.agent);
    const agent = listed.find((entry) => entry.id === created.id);
    // The same helper the app's "Copy session ID" action calls.
    const sessionId = agent ? getProviderSessionId(agent) : null;
    expect(sessionId).toBeTruthy();
    expect(sessionId).not.toBe(created.id);

    const paseo = (args: string[]) =>
      runLocalPaseo(["--host", `127.0.0.1:${ctx.daemon.port}`, ...args, "--json"], cliHome);

    // Daemon-resolved path: send resolves on the daemon, then waits on the resolved ID.
    const sent = await paseo(["send", sessionId!, "hello"]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({ agentId: created.id, status: "completed" });

    // CLI-resolved path: reload resolves against the agent list in the CLI.
    const reloaded = await paseo(["agent", "reload", sessionId!]);
    expect(reloaded.exitCode, reloaded.stderr).toBe(0);
    expect(JSON.parse(reloaded.stdout)).toMatchObject({ agentId: created.id });

    // An unknown session ID is an error, and neither imports nor creates an agent.
    const unknown = await paseo(["send", "00000000-0000-4000-8000-000000000000", "hello"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Agent not found");
    const after = (await ctx.client.fetchAgents()).entries.map((entry) => entry.agent.id);
    expect(after.sort()).toEqual(listed.map((entry) => entry.id).sort());
    const storage = ctx.daemon.daemon.agentStorage;
    expect(await storage.list()).toHaveLength(listed.length);

    // A second agent holding the same session ID makes it ambiguous on both paths; neither picks one.
    const stored = await storage.get(created.id);
    await storage.upsert({ ...stored!, id: "duplicate-session-agent", title: "duplicate" });
    for (const args of [
      ["send", sessionId!, "hello"],
      ["agent", "reload", sessionId!],
    ]) {
      const ambiguous = await paseo(args);
      expect(ambiguous.exitCode, ambiguous.stdout).toBe(1);
      expect(ambiguous.stderr).toContain(`matches 2 agents`);
      expect(ambiguous.stderr).toContain(created.id);
      expect(ambiguous.stderr).toContain("duplicate-session-agent");
    }
  } finally {
    await ctx.cleanup();
    await rm(cliHome, { recursive: true, force: true });
  }
}, 90_000);
