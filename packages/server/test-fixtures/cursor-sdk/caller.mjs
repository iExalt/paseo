import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { model } from "./backend.mjs";

const siblingWorkspace = "wks_cursor_parity_sibling";
const agentSetting = "newline\nquotation ' and literal $(false)";
const agentLabels = ["one", "two"];

const shellProbe = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const { P3_LABEL, P3_SETTING, PASEO_AGENT_ID, PASEO_AGENT_CWD,
  PASEO_WORKSPACE_ID, PASEO_CLI, CURSOR_API_KEY } = process.env;
assert.ok(P3_LABEL === "one" || P3_LABEL === "two");
assert.ok(PASEO_CLI, "Paseo CLI should be supplied by the daemon");
const receipt = execFileSync(PASEO_CLI, [
  "heartbeat", "create", "Fixture heartbeat", "--cron", "0 0 1 1 *",
  "--name", "cursor-parity-" + P3_LABEL, "--replace", "--json",
], { encoding: "utf8" });
writeFileSync("caller-" + P3_LABEL + ".json", JSON.stringify({
  caller: PASEO_AGENT_ID, cwd: PASEO_AGENT_CWD, workspace: PASEO_WORKSPACE_ID,
  setting: P3_SETTING, hostKey: Boolean(CURSOR_API_KEY), heartbeat: JSON.parse(receipt).id,
}));
`;

const mcpProbe = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { P3_MCP_LABEL, P3_LABEL, P3_SETTING, PASEO_AGENT_ID, CURSOR_API_KEY } = process.env;
writeFileSync(new URL("mcp-" + P3_MCP_LABEL + ".json", import.meta.url), JSON.stringify({
  explicit: P3_MCP_LABEL, launchEnv: Boolean(P3_LABEL || P3_SETTING),
  caller: Boolean(PASEO_AGENT_ID), hostKey: Boolean(CURSOR_API_KEY),
}));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "p3", version: "1" } }
    : { tools: [] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
});
`;

export async function prepareCallerFixture({ root, paseoHome, home, workspace }) {
  const { createPersistedProjectRecord, createPersistedWorkspaceRecord } = await import(
    pathToFileURL(join(root, "packages/server/dist/server/server/workspace-registry.js"))
  );
  const projectId = "prj_cursor_parity";
  const ownerWorkspace = "wks_cursor_parity";
  const timestamp = new Date().toISOString();
  const directory = join(paseoHome, "projects");
  await mkdir(directory);
  await Promise.all([
    writeFile(
      join(directory, "projects.json"),
      JSON.stringify([
        createPersistedProjectRecord({
          projectId,
          kind: "non_git",
          rootPath: workspace,
          displayName: "Cursor parity",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ]),
    ),
    writeFile(
      join(directory, "workspaces.json"),
      JSON.stringify(
        [ownerWorkspace, siblingWorkspace].map((workspaceId) =>
          createPersistedWorkspaceRecord({
            workspaceId,
            projectId,
            cwd: workspace,
            kind: "directory",
            displayName: workspaceId,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ),
      ),
    ),
    writeFile(
      join(home, ".bash_profile"),
      "export PASEO_AGENT_ID=stale-login PASEO_WORKSPACE_ID=stale-login P3_SETTING=stale-login",
    ),
    writeFile(join(workspace, "p3-shell.mjs"), shellProbe),
    writeFile(join(workspace, "p3-mcp.mjs"), mcpProbe),
  ]);
  return ownerWorkspace;
}

export async function checkCallerEnvironment({
  root,
  require,
  paseoHome,
  workspace,
  workspaceId,
  listener,
  agents,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const { acquirePidLock, releasePidLock } = await import(
    pathToFileURL(join(root, "packages/server/dist/server/server/pid-lock.js"))
  );
  const phase = agents ? "cold resume" : "create";
  const client = new DaemonClient({
    url: `ws://${listener()}/ws`,
    appVersion: "0.32.1",
    clientId: "cursor-parity-caller",
    reconnect: { enabled: false },
  });
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const workspaceIds = [workspaceId, siblingWorkspace];
  const settings = agentLabels.map((label) => `${label} ${agentSetting}`);
  await client.connect();
  let lockHeld = false;
  try {
    await acquirePidLock(paseoHome, listener());
    lockHeld = true;
    await client.patchDaemonConfig({ agentTools: { enabled: true } });
    const scopedAgents =
      agents ??
      (await Promise.all(
        agentLabels.map((label, index) =>
          client.createAgent({
            provider: "cursor-sdk",
            cwd: workspace,
            workspaceId: workspaceIds[index],
            model,
            modeId: "unrestricted",
            env: { P3_LABEL: label, P3_SETTING: settings[index] },
            mcpServers: {
              probe: {
                type: "stdio",
                command: "/bin/bash",
                args: [
                  "-c",
                  'exec "$1" "$2"',
                  "bash",
                  process.execPath,
                  join(workspace, "p3-mcp.mjs"),
                ],
                env: { P3_MCP_LABEL: label },
                cwd: workspace,
              },
            },
          }),
        ),
      ));
    await Promise.all(
      scopedAgents.map(async ({ id }) => {
        const result = await client.sendAgentMessage(
          id,
          `Run the synthetic caller canary on ${phase}.`,
        );
        assert.equal(result.disposition, "turn_started");
        assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
      }),
    );
    const { schedules } = await client.scheduleList();
    for (const [index, label] of agentLabels.entries()) {
      const receiptPath = join(workspace, `caller-${label}.json`);
      const mcpPath = join(workspace, `mcp-${label}.json`);
      const { heartbeat, ...env } = await readJson(receiptPath);
      assert.deepEqual(env, {
        caller: scopedAgents[index].id,
        cwd: workspace,
        workspace: workspaceIds[index],
        setting: settings[index],
        hostKey: false,
      });
      assert.equal(
        schedules.find(({ id }) => id === heartbeat)?.target.agentId,
        scopedAgents[index].id,
      );
      assert.deepEqual(await readJson(mcpPath), {
        explicit: label,
        launchEnv: false,
        caller: false,
        hostKey: false,
      });
      await Promise.all([rm(receiptPath), rm(mcpPath)]);
    }
    console.log(
      `PASS ${phase}: simultaneous same-cwd agents received their own caller, workspace, and env; explicit MCP env and heartbeat targets verified`,
    );
    return scopedAgents;
  } finally {
    try {
      await client.patchDaemonConfig({ agentTools: { enabled: false } });
    } finally {
      await client.close();
      if (lockHeld) await releasePidLock(paseoHome);
    }
  }
}
