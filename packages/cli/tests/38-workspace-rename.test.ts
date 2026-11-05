#!/usr/bin/env npx tsx

import assert from "node:assert";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { basename } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Workspace Rename Command ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  const created = await ctx.paseo([
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    ctx.workDir,
    "--title",
    "Original title",
    "--json",
  ]);
  assert.strictEqual(created.exitCode, 0, created.stderr);
  const workspaceId = JSON.parse(created.stdout).workspaceId as string;

  const renamed = await ctx.paseo(["workspace", "rename", workspaceId, "Auth rework", "--json"]);
  assert.strictEqual(renamed.exitCode, 0, renamed.stderr);
  assert.deepStrictEqual(JSON.parse(renamed.stdout), {
    success: true,
    workspaceId,
    title: "Auth rework",
  });

  const renamedList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(renamedList.exitCode, 0, renamedList.stderr);
  assert.strictEqual(
    JSON.parse(renamedList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    "Auth rework",
  );

  const reset = await ctx.paseo(["workspace", "rename", workspaceId, "--reset", "--json"]);
  assert.strictEqual(reset.exitCode, 0, reset.stderr);
  assert.deepStrictEqual(JSON.parse(reset.stdout), { success: true, workspaceId, title: null });

  const resetList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(resetList.exitCode, 0, resetList.stderr);
  assert.strictEqual(
    JSON.parse(resetList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    basename(ctx.workDir),
  );

  await verifyWorkspaceSettings(workspaceId);
  await verifyWorkspaceCallerContext();
} finally {
  await ctx.stop();
}

console.log("=== Workspace Rename Command Tests Passed ===");

async function verifyWorkspaceCallerContext() {
  const sdk = createPaseoClient({ url: `${ctx.wsUrl}/ws`, reconnect: { enabled: false } });
  try {
    await sdk.connect();
    const parentWorkspace = await sdk.workspaces.create({
      source: { kind: "directory", path: ctx.workDir },
      background: true,
    });
    // Creation without a prompt stays idle; this visibility test runs no provider turn.
    const parent = await parentWorkspace.agents.create({ config: { provider: "claude/haiku" } });
    const cases = [
      { caller: parent.id, background: undefined, expected: true },
      { caller: parent.id, background: false, expected: false },
      { caller: parent.id, background: true, expected: true },
      { caller: "foreign-or-missing-agent", background: undefined, expected: false },
      { caller: "foreign-or-missing-agent", background: true, expected: true },
      { caller: "foreign-or-missing-agent", background: false, expected: false },
      { caller: "", background: undefined, expected: false },
      { caller: "", background: true, expected: true },
    ];
    for (const entry of cases) {
      const result = await ctx.paseo(
        [
          "workspace",
          "create",
          "--host",
          `127.0.0.1:${ctx.port}`,
          "--isolation",
          "local",
          "--path",
          ctx.workDir,
          ...(entry.background === undefined
            ? []
            : [entry.background ? "--background" : "--no-background"]),
          "--json",
        ],
        { env: { PASEO_AGENT_ID: entry.caller } },
      );
      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.strictEqual(
        JSON.parse(result.stdout).background,
        entry.expected,
        JSON.stringify(entry),
      );
    }
    console.log("✓ workspace create caller inheritance, foreign/blank defaults, and overrides");
  } finally {
    await sdk.close();
  }
}

async function verifyWorkspaceSettings(workspaceId: string) {
  const driver = new DaemonClient({
    url: `${ctx.wsUrl}/ws`,
    clientId: "workspace-settings-e2e",
    reconnect: { enabled: false },
  });
  const sdk = createPaseoClient({ url: `${ctx.wsUrl}/ws`, reconnect: { enabled: false } });
  try {
    await driver.connect();
    await sdk.connect();
    await driver.setWorkspaceLabel({
      workspaceId,
      label: { name: "Review", color: "sky" },
      assigned: true,
    });
    const subscription = await sdk.workspaces.list({ subscribe: {} });
    const updates: Array<{ kind: string; id?: string; workspace?: { id: string } }> = [];
    const unsubscribe = sdk.workspaces.subscribe((update) => updates.push(update));
    const hidden = await ctx.paseo([
      "workspace",
      "update",
      workspaceId,
      "--background",
      "--title",
      "Hidden review",
      "--notifications",
      "off",
      "--pin",
      "--add-label",
      "review",
      "--json",
    ]);
    assert.equal(hidden.exitCode, 0, hidden.stderr);
    assert.deepEqual(JSON.parse(hidden.stdout), {
      workspaceId,
      background: true,
      title: "Hidden review",
      notifications: "off",
      pinnedAt: JSON.parse(hidden.stdout).pinnedAt,
      labels: ["Review"],
    });
    assert.ok(JSON.parse(hidden.stdout).pinnedAt);
    await waitForUpdate(() =>
      updates.some((update) => update.kind === "remove" && update.id === workspaceId),
    );
    const normal = await ctx.paseo(["workspace", "ls", "--json"]);
    assert.equal(normal.exitCode, 0, normal.stderr);
    assert.ok(
      !JSON.parse(normal.stdout).some(
        (entry: { workspaceId: string }) => entry.workspaceId === workspaceId,
      ),
    );
    const all = await ctx.paseo(["workspace", "ls", "--background", "--json"]);
    assert.equal(all.exitCode, 0, all.stderr);
    assert.ok(
      JSON.parse(all.stdout).some(
        (entry: { workspaceId: string }) => entry.workspaceId === workspaceId,
      ),
    );
    const rejected = await ctx.paseo([
      "workspace",
      "update",
      workspaceId,
      "--no-background",
      "--title",
      "Must not persist",
      "--add-label",
      "Unknown",
      "--json",
    ]);
    assert.notEqual(rejected.exitCode, 0);
    const handle = sdk.workspaces.ref(workspaceId);
    assert.equal((await handle.refresh())?.title, "Hidden review");
    assert.equal(handle.current()?.background, true);
    const visible = await ctx.paseo([
      "workspace",
      "update",
      workspaceId,
      "--no-background",
      "--reset-title",
      "--unpin",
      "--remove-label",
      "REVIEW",
      "--json",
    ]);
    assert.equal(visible.exitCode, 0, visible.stderr);
    assert.deepEqual(JSON.parse(visible.stdout), {
      workspaceId,
      background: false,
      title: null,
      notifications: "off",
      pinnedAt: null,
      labels: [],
    });
    await waitForUpdate(() =>
      updates.some((update) => update.kind === "upsert" && update.workspace?.id === workspaceId),
    );
    assert.equal((await handle.update({ title: "SDK update" })).title, "SDK update");
    assert.equal((await handle.refresh())?.title, "SDK update");
    unsubscribe();
    await subscription.subscription.release();
    console.log(
      "Workspace settings: atomic CLI/SDK updates, label validation, visibility lists and remove/upsert stream passed",
    );
  } finally {
    await driver.close();
    await sdk.close();
  }
}

async function waitForUpdate(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for workspace directory update");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
