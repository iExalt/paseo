import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentLaunchContext, AgentSessionConfig } from "./agent-sdk-types.js";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { resolvePaseoCliExecutablePath } from "../../terminal/paseo-cli-path.js";
import { acquirePidLock } from "../pid-lock.js";

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("managed agent context exposes a callable CLI scoped to its daemon and caller", async () => {
  const cliPath = resolvePaseoCliExecutablePath();
  if (!cliPath) throw new Error("Paseo CLI executable was not resolvable for the test");

  vi.stubEnv("PASEO_CLI", cliPath);
  vi.stubEnv("PASEO_HOME", "/stale/inherited/paseo-home");
  vi.stubEnv("PASEO_HOST", "stale.example:1234");
  const captured = new Map<string, { context?: AgentLaunchContext; config: AgentSessionConfig }>();
  const daemonContext = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      onLaunchContext: (context, config) => {
        const agentId = context?.env?.PASEO_AGENT_ID;
        if (agentId) captured.set(agentId, { context, config });
      },
    }),
  });
  const callerCwd = await mkdtemp(path.join(tmpdir(), "paseo-cli-caller-"));
  const otherCwd = await mkdtemp(path.join(tmpdir(), "paseo-cli-other-"));

  try {
    const callerWorkspace = await daemonContext.client.createWorkspace({
      source: { kind: "directory", path: callerCwd },
      title: "CLI caller",
    });
    const otherWorkspace = await daemonContext.client.createWorkspace({
      source: { kind: "directory", path: otherCwd },
      title: "Other agent",
    });
    if (!callerWorkspace.workspace || !otherWorkspace.workspace) {
      throw new Error("Failed to create isolated CLI test workspaces");
    }

    const caller = await daemonContext.client.createAgent({
      provider: "codex",
      cwd: callerCwd,
      workspaceId: callerWorkspace.workspace.id,
      title: "CLI caller",
    });
    const other = await daemonContext.client.createAgent({
      provider: "codex",
      cwd: otherCwd,
      workspaceId: otherWorkspace.workspace.id,
      title: "Other agent",
    });
    const launch = captured.get(caller.id);
    const runtimeEnv = launch?.context?.env;
    if (!runtimeEnv) throw new Error("Provider launch context was not captured");

    expect(runtimeEnv).toMatchObject({
      PASEO_AGENT_ID: caller.id,
      PASEO_AGENT_CWD: callerCwd,
      PASEO_HOME: daemonContext.daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_CLI: cliPath,
    });
    expect(launch.config.daemonAppendSystemPrompt).toContain("agent query");
    expect(launch.config.daemonAppendSystemPrompt).toContain('"$PASEO_CLI" <command> --help');

    await acquirePidLock(daemonContext.daemon.paseoHome, `127.0.0.1:${daemonContext.daemon.port}`);
    const childEnv = { ...process.env, ...runtimeEnv };
    const help = await runCli(cliPath, ["--help"], { cwd: callerCwd, env: childEnv });
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("agent");

    const query = await runCli(cliPath, ["agent", "query", "--json"], {
      cwd: callerCwd,
      env: childEnv,
    });
    expect(query.code, query.stderr).toBe(0);
    const agents = JSON.parse(query.stdout) as Array<{ id: string }>;
    expect(agents.map((agent) => agent.id)).toContain(caller.id);
    expect(agents.map((agent) => agent.id)).not.toContain(other.id);

    const markerPath = path.join(callerCwd, "mcp-smoke.txt");
    await writeFile(markerPath, "ok", "utf8");
    const run = await runCli(
      cliPath,
      [
        "agent",
        "run",
        "Call the Bash command tool with the exact command rm -f mcp-smoke.txt. Reply done after it finishes.",
        "--provider",
        "claude/claude-test-model",
        "--mode",
        "bypassPermissions",
        "--cwd",
        callerCwd,
        "--json",
      ],
      { cwd: callerCwd, env: childEnv },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "completed",
      cwd: callerCwd,
    });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await daemonContext.cleanup();
    await Promise.all([
      rm(callerCwd, { recursive: true, force: true }),
      rm(otherCwd, { recursive: true, force: true }),
    ]);
  }
});
