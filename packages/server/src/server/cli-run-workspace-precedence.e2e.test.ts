import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { parseAgentMessages } from "./agent/agent-messages/envelope.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

// The daemon-level workspace contract that `paseo run` depends on: each
// local-backed createWorkspace for a cwd mints a fresh, distinct workspace,
// createAgent stamps the agent with the workspaceId it is given, and attaching
// to an existing workspace by id creates no new record. The CLI's own flag
// precedence (--workspace > $PASEO_WORKSPACE_ID > --worktree > bare) is covered
// in packages/cli/src/commands/agent/run.test.ts. The notification cases below
// also exercise the real CLI against an isolated daemon and deterministic providers.

async function workspaceIds(client: DaemonClient): Promise<Set<string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

async function mintLocalWorkspace(client: DaemonClient, cwd: string): Promise<string> {
  const result = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (!result.workspace) {
    throw new Error(result.error ?? "Failed to create workspace");
  }
  return result.workspace.id;
}

test("daemon resolves human and managed CLI workspace ownership", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-cwd-"));
  const otherCwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-other-cwd-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    // A bare run mints a fresh local workspace for the cwd, then the agent is
    // stamped with that workspace's id.
    const firstWorkspaceId = await mintLocalWorkspace(client, cwd);

    const firstAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: firstWorkspaceId,
      title: "First run agent",
    });
    expect(firstAgent.workspaceId).toBe(firstWorkspaceId);
    expect(await workspaceIds(client)).toContain(firstWorkspaceId);

    const fetchedFirst = await client.fetchAgent({ agentId: firstAgent.id });
    expect(fetchedFirst?.agent.workspaceId).toBe(firstWorkspaceId);

    // A second bare run mints a distinct workspace with its own authoritative cwd.
    const secondWorkspaceId = await mintLocalWorkspace(client, otherCwd);
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);

    const secondAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
      workspaceId: secondWorkspaceId,
      title: "Second run agent",
    });
    expect(secondAgent.workspaceId).toBe(secondWorkspaceId);
    expect(secondAgent.workspaceId).not.toBe(firstAgent.workspaceId);

    const idsAfterTwoMints = await workspaceIds(client);
    expect(idsAfterTwoMints).toContain(firstWorkspaceId);
    expect(idsAfterTwoMints).toContain(secondWorkspaceId);

    // Attaching to an existing workspace by id (how --workspace and
    // $PASEO_WORKSPACE_ID land a run) creates no new workspace record: the
    // agent lands in the named workspace and the workspace set is unchanged.
    const idsBeforeAttach = await workspaceIds(client);
    const attachedAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: path.join(otherCwd, "stale-client-directory"),
      workspaceId: firstWorkspaceId,
      title: "Attached agent",
    });
    expect(attachedAgent.workspaceId).toBe(firstWorkspaceId);
    expect(attachedAgent.cwd).toBe(cwd);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    await expect(
      client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        workspaceId: "wks_missing",
        title: "Missing workspace agent",
      }),
    ).rejects.toThrow("Workspace wks_missing not found");

    const sameWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
      callerAgentId: firstAgent.id,
      title: "Same workspace child",
    });
    expect(sameWorkspaceChild.workspaceId).toBe(firstWorkspaceId);
    expect(sameWorkspaceChild.cwd).toBe(firstAgent.cwd);
    expect(sameWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    const crossWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: secondWorkspaceId,
      callerAgentId: firstAgent.id,
      title: "Cross workspace child",
    });
    expect(crossWorkspaceChild.workspaceId).toBe(secondWorkspaceId);
    expect(crossWorkspaceChild.cwd).toBe(otherCwd);
    expect(crossWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
}, 180000);

test.each(["COMPLETE_HANDOFF", "BLOCKED_APPROVAL_HANDOFF"])(
  "detached CLI run wakes an idle caller with its terminal %s",
  async (handoff) => {
    const release = Promise.withResolvers<void>();
    const received: Array<{ at: string; prompt: string }> = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        beforeTurnComplete: (prompt) =>
          String(prompt).includes("HOLD_CHILD") ? release.promise : Promise.resolve(),
        onStartTurn: (prompt) => {
          if (String(prompt).includes('kind="agent-notification"')) {
            received.push({ at: new Date().toISOString(), prompt: String(prompt) });
          }
        },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const parentWorkspace = await mintLocalWorkspace(client, daemon.staticDir);
      const workerWorkspace = await mintLocalWorkspace(client, daemon.staticDir);
      const parent = await client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd: daemon.staticDir,
        workspaceId: parentWorkspace,
        title: "Idle CLI caller",
      });
      await client.sendMessage(parent.id, "respond with exactly: WAITING_PARENT");
      expect((await client.waitForFinish(parent.id, 5000)).lastMessage).toBe("WAITING_PARENT");
      const registeredAfter = new Date().toISOString();
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${daemon.port}`,
          "run",
          "--provider",
          "codex",
          "--mode",
          "full-access",
          "--workspace",
          workerWorkspace,
          "--relationship",
          "detached",
          "--notify-on-finish",
          "--no-wait",
          "--json",
          `HOLD_CHILD\nrespond with exactly: ${handoff}`,
        ],
        {
          env: {
            ...process.env,
            PASEO_HOME: daemon.paseoHome,
            PASEO_AGENT_ID: parent.id,
            PASEO_AGENT_CWD: daemon.staticDir,
          },
          timeout: 20000,
        },
      );
      const workerId = JSON.parse(stdout).agentId as string;
      expect(workerId).toBeTruthy();
      const worker = (await client.fetchAgent(workerId))!.agent;
      expect(worker.workspaceId).toBe(workerWorkspace);
      expect(worker.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
      const registrations = JSON.parse(
        await readFile(path.join(daemon.paseoHome, "finish-subscriptions.json"), "utf8"),
      );
      expect(registrations).toEqual([
        expect.objectContaining({ callerAgentId: parent.id, childAgentId: workerId }),
      ]);
      expect((await client.fetchAgent(parent.id))!.agent.status).toBe("idle");
      expect(received).toEqual([]);
      const releasedAt = new Date().toISOString();
      release.resolve();
      expect((await client.waitForFinish(workerId, 5000)).lastMessage).toBe(handoff);
      await expect.poll(() => received.length, { timeout: 5000 }).toBe(1);
      const notification = parseAgentMessages(received[0]!.prompt)![0]!;
      expect(notification.source).toMatchObject({
        kind: "agent-notification",
        agentId: workerId,
        event: "finished",
      });
      expect(notification.text).toContain(`<agent-response>\n${handoff}\n</agent-response>`);
      const response = await client.waitForFinish(parent.id, 5000);
      expect(response.status).toBe("idle");
      expect(response.lastMessage).toBe("Hello world");
      console.info(
        JSON.stringify({
          handoff,
          parentId: parent.id,
          workerId,
          registeredAfter,
          registrations,
          releasedAt,
          receivedAt: received[0]!.at,
          respondedAt: new Date().toISOString(),
          response: response.lastMessage,
        }),
      );
    } finally {
      release.resolve();
      await client.close();
      await daemon.close();
    }
  },
  30000,
);
