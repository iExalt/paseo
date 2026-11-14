import assert from "node:assert/strict";
import { createPaseoClient } from "@getpaseo/client";
import { createE2ETestContext } from "./helpers/test-daemon.ts";
import { waitForTerminalOutput } from "./helpers/terminal.ts";

const ctx = await createE2ETestContext({ timeout: 30_000 });
function identity(terminal: { id: string; workspaceId: string; cwd: string; name: string }) {
  return {
    id: terminal.id,
    workspaceId: terminal.workspaceId,
    cwd: terminal.cwd,
    name: terminal.name,
  };
}

const sdk = createPaseoClient({ url: `${ctx.wsUrl}/ws`, reconnect: { enabled: false } });

async function cli(args: string[]) {
  const result = await ctx.paseo([...args, "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  await sdk.connect();
  const first = await sdk.workspaces.create({
    source: { kind: "directory", path: ctx.workDir },
    title: "main",
  });
  const second = await sdk.workspaces.create({
    source: { kind: "directory", path: ctx.workDir },
    title: "feature-work",
  });
  const main = await cli(["terminal", "create", "--cwd", ctx.workDir, "--name", "Main"]);
  assert.equal(main.workspaceId, first.id);
  const feature = await cli(["terminal", "create", "--workspace", second.id, "--name", "Feature"]);
  assert.deepEqual(
    { id: feature.id, name: feature.name, cwd: feature.cwd, workspaceId: feature.workspaceId },
    {
      id: feature.id,
      name: "Feature",
      cwd: ctx.workDir,
      workspaceId: second.id,
    },
  );
  assert.deepEqual(
    (await cli(["terminal", "ls", "--workspace", second.id])).map(identity),
    [feature].map(identity),
  );
  assert.deepEqual(
    (await cli(["terminal", "ls", "--cwd", ctx.workDir])).map(identity),
    [main, feature].map(identity),
  );
  assert.deepEqual(
    (await cli(["terminal", "ls", "--all"])).map(identity),
    [main, feature].map(identity),
  );
  const invalid = await ctx.paseo([
    "terminal",
    "create",
    "--workspace",
    "wks_missing",
    "--cwd",
    ctx.workDir,
    "--json",
  ]);
  assert.notEqual(invalid.exitCode, 0);
  assert.match(invalid.stderr, /not active or does not exist/);
  const conflict = await ctx.paseo(["terminal", "ls", "--all", "--workspace", second.id]);
  assert.notEqual(conflict.exitCode, 0);

  const renamed = await cli(["terminal", "rename", feature.id.slice(0, 8), "Renamed feature"]);
  assert.equal(renamed.title, "Renamed feature");
  feature.title = "Renamed feature";
  const launched = await cli([
    "terminal",
    "create",
    "--workspace",
    second.id,
    "--command",
    process.execPath,
    "--arg=-e",
    "--arg",
    "console.log('CLI_ARG:' + process.argv[1] + ':' + process.stdout.rows + ':' + process.stdout.columns); setInterval(() => {}, 1000)",
    "--arg",
    "space value",
    "--rows",
    "33",
    "--cols",
    "101",
  ]);
  await waitForTerminalOutput(ctx.paseo, launched.id, "CLI_ARG:space value:33:101");
  await cli(["terminal", "kill", launched.id]);
  const invalidSize = await ctx.paseo(["terminal", "create", "--rows", "0"]);
  assert.notEqual(invalidSize.exitCode, 0);
  const conflictProfile = await ctx.paseo([
    "terminal",
    "create",
    "--profile",
    "codex",
    "--command",
    "echo",
  ]);
  assert.notEqual(conflictProfile.exitCode, 0);
  await sdk.config.patch({
    terminalProfiles: [
      {
        id: "test-profile",
        name: "Profile",
        command: process.execPath,
        args: [
          "-e",
          "console.log('PROFILE_ARGC:' + process.argv.length); setInterval(() => {}, 1000)",
          "{{{prompt}}}",
        ],
      },
    ],
  });
  const profiled = await cli([
    "terminal",
    "create",
    "--workspace",
    second.id,
    "--profile",
    "test-profile",
  ]);
  assert.equal(profiled.name, "Profile");
  await waitForTerminalOutput(ctx.paseo, profiled.id, "PROFILE_ARGC:1");
  await cli(["terminal", "kill", profiled.id]);
  const caller = await second.agents.create({ config: { provider: "claude/haiku" } });
  const scopedResult = await ctx.paseo(
    [
      "terminal",
      "create",
      "--command",
      process.execPath,
      "--arg=-e",
      "--arg",
      "console.log('CALLER_SIZE:' + process.stdout.rows + ':' + process.stdout.columns); setInterval(() => {}, 1000)",
      "--rows",
      "35",
      "--cols",
      "103",
      "--json",
    ],
    { env: { PASEO_AGENT_ID: caller.id } },
  );
  assert.equal(scopedResult.exitCode, 0, scopedResult.stderr);
  const scoped = JSON.parse(scopedResult.stdout);
  assert.equal(scoped.workspaceId, second.id);
  assert.equal(scoped.activity, null);
  await waitForTerminalOutput(ctx.paseo, scoped.id, "CALLER_SIZE:35:103");
  await cli(["terminal", "rename", scoped.id, "Caller title"]);
  const callerList = await ctx.paseo(["terminal", "ls", "--json"], {
    env: { PASEO_AGENT_ID: caller.id },
  });
  assert.equal(callerList.exitCode, 0, callerList.stderr);
  const callerTerminal = JSON.parse(callerList.stdout).find(
    (entry: { id: string }) => entry.id === scoped.id,
  );
  assert.equal(callerTerminal.title, "Caller title");
  assert.ok("activity" in callerTerminal);
  await cli(["terminal", "kill", scoped.id]);
  const terminal = await second.terminals.create({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.setRawMode(true); process.stdin.resume(); console.log('READY'); let hex = ''; process.stdin.on('data', data => { hex += data.toString('hex'); console.log('HEX:' + hex); });",
    ],
  });
  await waitForTerminalOutput(ctx.paseo, terminal.id, "READY");
  assert.deepEqual(await cli(["terminal", "send-keys", terminal.id, "-l", "Enter"]), {
    terminalId: terminal.id,
    keysSent: 5,
  });
  await waitForTerminalOutput(ctx.paseo, terminal.id, "HEX:456e746572");
  assert.deepEqual(await cli(["terminal", "send-keys", terminal.id, "Enter"]), {
    terminalId: terminal.id,
    keysSent: 1,
  });
  await waitForTerminalOutput(ctx.paseo, terminal.id, "HEX:456e7465720d");
  assert.deepEqual(await cli(["terminal", "kill", terminal.id]), {
    terminalId: terminal.id,
    success: true,
  });
  await cli(["terminal", "kill", feature.id]);
  assert.deepEqual(await cli(["terminal", "ls", "--workspace", second.id]), []);
  assert.deepEqual(
    (await cli(["terminal", "ls", "--workspace", first.id])).map(identity),
    [main].map(identity),
  );
  console.log("Terminal workspace CLI: ownership, lists, input, capture, kill, and errors passed");
} finally {
  await sdk.close();
  await ctx.stop();
}
