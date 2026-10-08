import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { render } from "../../../cli/src/output/index.js";
import { runCreateCommand } from "../../../cli/src/commands/workspace/create.js";
import { runLsCommand } from "../../../cli/src/commands/workspace/ls.js";
import { runUpdateCommand } from "../../../cli/src/commands/workspace/update.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

async function readPersistedPolicy(
  filePath: string,
  workspaceId: string,
): Promise<string | undefined> {
  const records = JSON.parse(await readFile(filePath, "utf8")) as Array<{
    workspaceId: string;
    notifications?: string;
  }>;
  return records.find((record) => record.workspaceId === workspaceId)?.notifications;
}

test("CLI and MCP create and update durable workspace notification policies", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "paseo-workspace-notifications-"));
  const homeRoot = path.join(fixtureRoot, "home");
  const staticDir = path.join(fixtureRoot, "static");
  const localDirectory = path.join(fixtureRoot, "local");
  const mcpDirectory = path.join(fixtureRoot, "mcp-local");
  const repository = path.join(fixtureRoot, "repository");
  let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
  let mcpClient: Client | undefined;
  try {
    await Promise.all([
      mkdir(staticDir, { recursive: true }),
      mkdir(localDirectory, { recursive: true }),
      mkdir(mcpDirectory, { recursive: true }),
      mkdir(repository, { recursive: true }),
    ]);
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Paseo Test"], {
      cwd: repository,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "paseo-test@example.invalid"], {
      cwd: repository,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "core.hooksPath", "/dev/null"], {
      cwd: repository,
      stdio: "ignore",
    });
    await writeFile(path.join(repository, "README.md"), "isolated notification fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], {
      cwd: repository,
      stdio: "ignore",
    });

    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      staticDir,
      listen: "127.0.0.1",
      listenPort: 0,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      cleanup: false,
    });
    const daemonTarget = {
      kind: "endpoint" as const,
      host: `127.0.0.1:${daemon.port}`,
    };
    const workspaceRegistryPath = path.join(daemon.paseoHome, "projects", "workspaces.json");

    const local = await runCreateCommand(
      {
        daemonTarget,
        isolation: "local",
        path: localDirectory,
        notifications: "off",
      },
      {} as never,
    );
    const worktree = await runCreateCommand(
      {
        daemonTarget,
        isolation: "worktree",
        path: repository,
        mode: "branch-off",
        newBranch: "notification-fixture",
        base: "main",
        notifications: "off",
      },
      {} as never,
    );
    expect(local.data.notifications).toBe("off");
    expect(worktree.data.notifications).toBe("off");
    expect(await readPersistedPolicy(workspaceRegistryPath, local.data.workspaceId)).toBe("off");
    expect(await readPersistedPolicy(workspaceRegistryPath, worktree.data.workspaceId)).toBe("off");

    const localOn = await runUpdateCommand(
      local.data.workspaceId,
      { daemonTarget, notifications: "on" },
      {} as never,
    );
    const worktreeOn = await runUpdateCommand(
      worktree.data.workspaceId,
      { daemonTarget, notifications: "on" },
      {} as never,
    );
    expect(localOn.data.notifications).toBe("on");
    expect(worktreeOn.data.notifications).toBe("on");
    expect(await readPersistedPolicy(workspaceRegistryPath, local.data.workspaceId)).toBe("on");
    expect(await readPersistedPolicy(workspaceRegistryPath, worktree.data.workspaceId)).toBe("on");

    const listed = await runLsCommand({ daemonTarget }, {} as never);
    expect(listed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: local.data.workspaceId, notifications: "on" }),
        expect.objectContaining({ workspaceId: worktree.data.workspaceId, notifications: "on" }),
      ]),
    );
    expect(
      JSON.parse(render(listed, { format: "json", quiet: false, noHeaders: false, noColor: true })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: local.data.workspaceId, notifications: "on" }),
        expect.objectContaining({ workspaceId: worktree.data.workspaceId, notifications: "on" }),
      ]),
    );

    const mcpToken = daemon.daemon.agentManager.getMcpAuthToken();
    if (!mcpToken) throw new Error("Test daemon did not provide its internal MCP capability");
    mcpClient = new Client({ name: "workspace-notification-test", version: "0.0.0" });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`), {
        requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
      }),
    );
    const mcpCreated = await mcpClient.callTool({
      name: "create_workspace",
      arguments: { isolation: "local", path: mcpDirectory, notifications: "off" },
    });
    expect(mcpCreated.structuredContent).toMatchObject({ notifications: "off" });
    const mcpWorkspaceId = (mcpCreated.structuredContent as { workspaceId: string }).workspaceId;
    expect(await readPersistedPolicy(workspaceRegistryPath, mcpWorkspaceId)).toBe("off");

    const mcpOn = await mcpClient.callTool({
      name: "set_workspace_notifications",
      arguments: { workspaceId: mcpWorkspaceId, notifications: "on" },
    });
    const mcpOff = await mcpClient.callTool({
      name: "set_workspace_notifications",
      arguments: { workspaceId: mcpWorkspaceId, notifications: "off" },
    });
    expect(mcpOn.structuredContent).toEqual({ workspaceId: mcpWorkspaceId, notifications: "on" });
    expect(mcpOff.structuredContent).toEqual({ workspaceId: mcpWorkspaceId, notifications: "off" });
    expect(await readPersistedPolicy(workspaceRegistryPath, mcpWorkspaceId)).toBe("off");

    const mcpListed = await mcpClient.callTool({ name: "list_workspaces", arguments: {} });
    expect(mcpListed.structuredContent).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ workspaceId: mcpWorkspaceId, notifications: "off" }),
      ]),
    });
  } finally {
    try {
      await mcpClient?.close().catch(() => undefined);
    } finally {
      try {
        await daemon?.close();
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
});
