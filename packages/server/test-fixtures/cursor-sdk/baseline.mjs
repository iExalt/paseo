import { fixtureStore } from "./fixture-store.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assistantText, model } from "./backend.mjs";

const base = "d0731444316f7a8030b2557fe306866b7e73734a";
const skill = "cursor-parity-fixture";
const skillText =
  "---\nname: cursor-parity-fixture\ndescription: Synthetic parity skill.\n---\nUse the parity fixture.\n";

export const shellEnvironment = [
  'printf \'%s\\n\' "${PASEO_AGENT_ID:-ABSENT}" "${PASEO_AGENT_CWD:-ABSENT}" "${PASEO_WORKSPACE_ID:-ABSENT}" "${PARITY_RUN_ENV:-ABSENT}" "${PARITY_STARTUP_ENV:-ABSENT}" > cursor-environment.txt',
  "if [ -f cursor-hold ]; then",
  "  printf '%s' \"$$\" > cursor-shell.pid",
  "  while [ -f cursor-hold ]; do sleep 0.1; done",
  "fi",
];

export async function prepareBaseline(root, workspace, home, codex, origin) {
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    base,
  );
  assert.ok(codex?.startsWith("/"), "Pass an absolute path to the offline Codex comparator");
  for (const source of [".cursor", ".agents"]) {
    const dir = join(workspace, source, "skills", skill);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillText);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  // The comparator talks to its local app server and reads the fixture skill.
  const codexHome = join(home, ".codex");
  await mkdir(codexHome);
  await writeFile(
    join(codexHome, "config.toml"),
    [
      `openai_base_url = "${origin}/codex/v1"`,
      "check_for_update_on_startup = false",
      "[analytics]",
      "enabled = false",
      "[features]",
      "plugins = false",
      "remote_models = false",
      "apps = false",
      "",
    ].join("\n"),
  );
  const wrapper = join(home, "codex-fixture");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      'if [ "$1" = app-server ] && [ -n "${PASEO_AGENT_ID:-}" ]; then',
      '  printf "%s\\n" "$PASEO_AGENT_ID" "$PASEO_AGENT_CWD" "$PASEO_WORKSPACE_ID" "$PARITY_RUN_ENV" > "$HOME/codex-caller.txt"',
      "fi",
      'exec "$PARITY_CODEX" "$@"',
    ].join("\n") + "\n",
    { mode: 0o700 },
  );
  return { command: [wrapper] };
}

async function eventually(label, read) {
  const deadline = Date.now() + 10000;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export async function checkBaseline({
  backend,
  cli,
  home,
  launch,
  listener,
  paseoHome,
  require,
  startDaemon,
  stopDaemon,
  workspace,
  workspaceId,
  checkCompleted,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const store = () => fixtureStore(require, join(paseoHome, "cursor-sdk"));
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://${listener()}/ws`,
      appVersion: "0.32.1",
      clientId: "cursor-parity-baseline",
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.fetchAgents();
    return client;
  };

  const catalog = await cli("provider", "models", "cursor-sdk");
  assert.ok(
    catalog.some(({ id }) => id === model),
    "Cursor fixture model missing from catalog",
  );
  const draft = (provider, selection) =>
    cli("provider", "commands", provider, "--model", selection, "--cwd", workspace);
  const cursorDraft = await draft("cursor-sdk", model);
  const codexDraft = await draft("codex", "gpt-5.4-mini");

  const control = await launch(
    workspaceId,
    "Run an unstalled shell.",
    "--env",
    "PARITY_RUN_ENV=per-run",
  );
  await checkCompleted(control);
  const cursorExisting = await cli("agent", "commands", control.agentId);
  const hasFixtureSkill = (commands) =>
    commands.some(({ name, kind }) => name.includes(skill) && kind === "skill");
  assert.ok(hasFixtureSkill(codexDraft));
  assert.deepEqual(cursorDraft, []);
  assert.deepEqual(cursorExisting, []);

  let client = await connect();
  try {
    const codex = await client.createAgent({
      provider: "codex",
      workspaceId,
      cwd: workspace,
      modeId: "full-access",
      env: { PARITY_RUN_ENV: "per-run" },
    });
    assert.ok(hasFixtureSkill(await cli("agent", "commands", codex.id)));
    console.log(
      "BASELINE skills: explicit-model Cursor draft and existing catalogs empty; Codex finds the fixture through both",
    );
    const readLines = async (path) => (await readFile(path, "utf8")).trim().split("\n");
    assert.deepEqual(await readLines(join(home, "codex-caller.txt")), [
      codex.id,
      workspace,
      workspaceId,
      "per-run",
    ]);
    assert.deepEqual(await readLines(join(workspace, "cursor-environment.txt")), [
      "ABSENT",
      "ABSENT",
      "ABSENT",
      "ABSENT",
      "daemon-wide",
    ]);
    console.log(
      "BASELINE caller: Cursor shell drops caller scope and per-run env; daemon sentinel survives and Codex has exact scope and per-run env",
    );

    const hold = join(workspace, "cursor-hold");
    await writeFile(hold, "");
    const crashed = await launch(workspaceId, "Run a held shell.", "--no-wait");
    const nativeId = await eventually("native agent handle", async () => {
      const fetched = await client.fetchAgent(crashed.agentId);
      return fetched?.agent.persistence?.nativeHandle ?? fetched?.agent.persistence?.sessionId;
    });
    const runs = async () => (await store().runs.list({ filter: { agentIds: [nativeId] } })).items;
    const staleRunId = await eventually("native running shell event", async () => {
      const run = (await runs()).find(({ status }) => status === "running");
      if (!run) return;
      const { items } = await store().runEvents.list({ runId: run.runId });
      if (
        items.some(
          ({ payload }) =>
            payload?.message?.type === "tool_call" &&
            payload.message.name === "shell" &&
            payload.message.status === "running",
        )
      ) {
        return run.runId;
      }
    });
    const shellPid = await eventually("shell process start", async () =>
      Number(
        await readFile(join(workspace, "cursor-shell.pid"), "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return "0";
        }),
      ),
    );
    assert.ok(Number.isInteger(shellPid) && shellPid > 1);
    await stopDaemon("SIGKILL");
    try {
      process.kill(shellPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await unlink(hold);
    await client.close();

    await startDaemon();
    client = await connect();
    const pages = (id) => client.fetchAgentTimeline(id, { limit: 60, timeout: 8000 });
    const cold = await pages(crashed.agentId);
    assert.equal(cold.agent.status, "idle");
    assert.deepEqual(cold.entries, []);
    assert.equal(await client.cancelAgent(crashed.agentId), false);
    const nativeState = async () => (await runs()).map(({ runId, status }) => [runId, status]);
    const beforeFollowUp = await nativeState();
    assert.equal(beforeFollowUp.find(([runId]) => runId === staleRunId)?.[1], "running");
    const nextPrompt = "Try a follow-up.";
    assert.equal(
      (await client.sendAgentMessage(crashed.agentId, nextPrompt)).disposition,
      "turn_started",
    );
    await eventually("stale run error", async () => {
      const result = await pages(crashed.agentId);
      return (
        result.agent.status === "error" &&
        result.entries.some(
          ({ item }) => item.type === "user_message" && item.text === nextPrompt,
        ) &&
        result.entries.some(
          ({ item }) =>
            item.type === "assistant_message" &&
            /^\[System Error\].*already has active run/i.test(item.text),
        )
      );
    });
    assert.deepEqual(await nativeState(), beforeFollowUp);
    assert.equal(backend.runs, 2, "The stale follow-up started an unexpected backend run");

    const replay = await pages(control.agentId);
    assert.ok(
      replay.entries.some(
        ({ item }) => item.type === "assistant_message" && item.text === assistantText,
      ),
    );
    assert.equal(
      (await client.sendAgentMessage(control.agentId, "Run another unstalled shell.")).disposition,
      "turn_started",
    );
    await eventually("completed control follow-up", async () => {
      const result = await pages(control.agentId);
      const assistantRows = result.entries.filter(
        ({ item }) => item.type === "assistant_message" && item.text === assistantText,
      );
      return result.agent.status === "idle" && assistantRows.length === 2;
    });
    assert.equal(backend.runs, 3);
    assert.equal(backend.shellReplies, 2);
    console.log(
      "BASELINE stale run: real shell started before SIGKILL; cold agent idle, Stop false, follow-up refused by SDK; completed control reopens and sends",
    );
  } finally {
    await client.close();
  }
}
