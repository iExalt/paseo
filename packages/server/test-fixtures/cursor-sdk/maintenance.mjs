import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { apiKey, assistantText } from "./backend.mjs";

const exec = promisify(execFile);
import { maintenancePrefix, summaryText } from "./maintenance-wire.mjs";
const originalPrompt = maintenancePrefix + " external original.";
const externalModel = "fixture-high";

async function seedSessions(modulePath, cwd, storePath) {
  const { Agent, JsonlLocalAgentStore } = createRequire(import.meta.url)(modulePath);
  const create = (where) =>
    Agent.create({
      apiKey,
      model: {
        id: externalModel,
        params: [
          { id: "fast", value: "false" },
          { id: "reasoning_effort", value: "high" },
        ],
      },
      name: "P6 external Cursor conversation",
      local: {
        cwd,
        store: new JsonlLocalAgentStore(where),
        settingSources: [],
        sandboxOptions: { enabled: false },
      },
    });
  const [id, outsideId] = await Promise.all(
    [storePath, storePath + "-outside"].map(async (where) => {
      await using agent = await create(where);
      const run = await agent.send(originalPrompt);
      assert.equal((await run.wait()).status, "finished");
      return agent.agentId;
    }),
  );
  await using pending = await create(storePath);
  console.log(JSON.stringify({ id, outsideId, pendingId: pending.agentId }));
}

if (process.argv[2] === "seed") {
  await seedSessions(...process.argv.slice(3));
}

async function fixtureProcessAlive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function checkBackgroundShell({ client, send, workspace, workspaceId, model, native }) {
  const script = join(workspace, "cursor-canary.sh");
  const initial = await readFile(script);
  const hold = join(workspace, "p6-background-hold");
  const pidFile = join(workspace, "p6-background.pid");
  await writeFile(hold, "");
  await writeFile(
    script,
    [
      "set -eu",
      "(while test -f p6-background-hold; do sleep 0.05; done) </dev/null >/dev/null 2>&1 &",
      'printf "%s" "$!" > p6-background.pid',
      "printf 'P6_BACKGROUND_STARTED'",
    ].join("\n"),
  );
  let pid;
  try {
    const agent = await client.createAgent({
      provider: "cursor-sdk",
      workspaceId,
      cwd: workspace,
      model,
      modeId: "unrestricted",
    });
    await send(agent.id, "Run the background shell fixture.");
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 1 && (await fixtureProcessAlive(pid)));
    const id = (await client.fetchAgent(agent.id)).agent.persistence.nativeHandle;
    await assert.rejects(client.listAgentBackgroundWork(agent.id), /inventory is unavailable/);
    await assert.rejects(
      client.stopAgentBackgroundWork(agent.id, {
        id: "p6-fixture-shell",
        canStop: true,
        stopToken: "p6-fixture-token",
      }),
      /Background work cannot be stopped/,
    );
    const saved = await native(id);
    await client.closeAgent(agent.id);
    assert.ok(await fixtureProcessAlive(pid), "Idle runtime close killed the background process");
    await client.archiveAgent(agent.id);
    assert.ok(
      await fixtureProcessAlive(pid),
      "Paseo archive killed independent shell work after close",
    );
    await client.deleteAgent(agent.id);
    assert.ok(
      await fixtureProcessAlive(pid),
      "Deleting the Paseo record killed independent shell work",
    );
    assert.deepEqual(await native(id), saved);
    console.log(
      "PASS owned fixture shell outlives idle close, archive and delete without advertising an independent Stop",
    );
  } finally {
    await rm(hold, { force: true });
    await writeFile(script, initial);
    if (pid) {
      const deadline = Date.now() + 1500;
      while ((await fixtureProcessAlive(pid)) && Date.now() < deadline) await delay(25);
      if (await fixtureProcessAlive(pid)) process.kill(pid, "SIGTERM");
    }
  }
}

export async function checkMaintenance({
  backend,
  cli,
  home,
  listener,
  model,
  paseoHome,
  require,
  startDaemon,
  stopDaemon,
  workspace,
  workspaceId,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const sdkPath = require.resolve("@cursor/sdk");
  const { Agent, JsonlLocalAgentStore } = require("@cursor/sdk");
  const storePath = join(paseoHome, "cursor-sdk");
  const store = new JsonlLocalAgentStore(storePath);
  const { stdout } = await exec(
    process.execPath,
    [fileURLToPath(import.meta.url), "seed", sdkPath, workspace, storePath],
    {
      env: {
        ...process.env,
        HOME: home,
        CURSOR_API_BASE_URL: backend.origin,
        CURSOR_BACKEND_URL: backend.origin,
      },
      timeout: 12_000,
    },
  );
  const { id, outsideId, pendingId } = JSON.parse(stdout.trim().split("\n").at(-1));
  const native = (agentId = id) => store.agents.get({ agentId });
  const nativeRuns = (agentId = id) => store.runs.list({ filter: { agentIds: [agentId] } });
  const original = await native();
  assert.ok(original.latestCheckpoint, "Loopback run did not persist a native checkpoint");
  const rootBlob = { agentId: id, blobId: original.latestCheckpoint.rootBlobId };
  const originalCheckpoint = await store.checkpoints.get(rootBlob);
  assert.ok(originalCheckpoint);
  const originalRuns = await nativeRuns();
  const [{ runId }] = originalRuns.items;
  const nativeEvents = await store.runEvents.list({ runId });
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://${listener()}/ws`,
      appVersion: "0.32.1",
      clientId: "cursor-parity-maintenance",
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.fetchAgents();
    return client;
  };
  let client = await connect();
  const list = (cwd = workspace) =>
    client.fetchRecentProviderSessions({ cwd, providers: ["cursor-sdk"], limit: 30 });
  const importAgent = (providerHandleId, options) =>
    client.importAgent({
      providerId: "cursor-sdk",
      providerHandleId,
      cwd: workspace,
      workspaceId,
      ...options,
    });
  const timeline = (agentId) => client.fetchAgentTimeline(agentId, { limit: 100, timeout: 8000 });
  const snapshot = async (agentId) => (await client.fetchAgent(agentId)).agent;
  const send = async (agentId, text, messageId = randomUUID()) => {
    assert.equal(
      (await client.sendAgentMessage(agentId, text, { messageId })).disposition,
      "turn_started",
    );
    assert.equal((await client.waitForFinish(agentId, 10_000)).status, "idle");
    return messageId;
  };
  try {
    const recent = await list();
    assert.deepEqual(recent.providerErrors ?? [], []);
    assert.equal(recent.entries.filter((entry) => entry.providerHandleId === id).length, 1);
    assert.ok(
      recent.entries.every((entry) => ![outsideId, pendingId].includes(entry.providerHandleId)),
    );
    const wrongWorkspace = join(workspace, "p6-other-cwd");
    await mkdir(wrongWorkspace);
    assert.equal((await list(wrongWorkspace)).entries.length, 0);
    await assert.rejects(
      client.resumeAgent({
        provider: "cursor-sdk",
        sessionId: id,
        nativeHandle: id,
        metadata: { cwd: workspace },
      }),
      /Import this local Cursor SDK session/,
    );
    await assert.rejects(importAgent(outsideId), /not found in the host store/);
    await assert.rejects(importAgent(pendingId), /idle Cursor SDK session/);
    await assert.rejects(
      importAgent(id, { cwd: wrongWorkspace, workspaceId: undefined }),
      /not found in the host store/,
    );
    const attempts = await Promise.allSettled([importAgent(id), importAgent(id)]);
    const accepted = attempts.find(({ status }) => status === "fulfilled");
    assert.ok(accepted);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    assert.match(
      attempts.find(({ status }) => status === "rejected").reason.message,
      /already imported/,
    );
    const agentId = accepted.value.id;
    assert.equal(accepted.value.persistence.nativeHandle, id);
    assert.equal(accepted.value.model, externalModel);
    assert.equal(accepted.value.options?.cursor_model_reasoning_effort, "high");
    const reopened = await Promise.all([
      client.resumeAgent(accepted.value.persistence),
      client.resumeAgent(accepted.value.persistence),
    ]);
    assert.deepEqual(
      reopened.map((result) => result.id),
      [agentId, agentId],
    );
    assert.ok((await list()).entries.every((entry) => entry.providerHandleId !== id));
    assert.deepEqual(await native(), original);
    assert.deepEqual(await nativeRuns(), originalRuns);
    assert.deepEqual(await store.checkpoints.get(rootBlob), originalCheckpoint);
    assert.deepEqual(await store.runEvents.list({ runId }), nativeEvents);
    const imported = (await timeline(agentId)).entries;
    const user = imported.find(
      ({ item }) => item.type === "user_message" && item.text === originalPrompt,
    );
    assert.equal(user?.turnId, runId);
    assert.ok(user.item.messageId);
    assert.ok(
      imported.some(({ item }) => item.type === "assistant_message" && item.text === assistantText),
    );
    console.log(
      "PASS authorized native import deduplicated and preserved the SDK agent, run, events and model",
    );

    const commands = await cli("agent", "commands", agentId);
    assert.ok(commands.some(({ name, kind }) => name === "compact" && kind === "command"));
    const commandId = await send(agentId, "/compact");
    const compacted = (await timeline(agentId)).entries;
    const commandRow = compacted.find(({ item }) => item.clientMessageId === commandId);
    assert.ok(commandRow?.turnId);
    assert.ok(
      compacted.some(
        ({ item, turnId }) =>
          turnId === commandRow.turnId &&
          item.type === "compaction" &&
          item.status === "completed" &&
          item.trigger === "manual",
      ),
    );
    assert.ok(
      compacted.some(
        ({ item, turnId }) =>
          turnId === commandRow.turnId &&
          item.type === "assistant_message" &&
          item.text === summaryText,
      ),
    );
    const summaryRun = (await nativeRuns()).items.find((run) => run.result === summaryText);
    assert.equal(summaryRun?.model?.id, externalModel);
    assert.ok(
      summaryRun.model.params.some(
        ({ id: parameter, value }) => parameter === "reasoning_effort" && value === "high",
      ),
    );
    const compactedNative = await native();
    assert.notDeepEqual(compactedNative.latestCheckpoint, original.latestCheckpoint);
    assert.equal(backend.maintenanceSummaries, 1);

    const socket = listener();
    await client.close();
    await stopDaemon("SIGTERM");
    await startDaemon({ listen: socket });
    client = await connect();
    const cold = (await timeline(agentId)).entries;
    const coldUser = cold.find(
      ({ item }) => item.type === "user_message" && item.text === originalPrompt,
    );
    assert.equal(coldUser?.item.messageId, user.item.messageId);
    assert.equal(coldUser.turnId, runId);
    assert.ok(
      cold.some(
        ({ item, turnId }) =>
          turnId === commandRow.turnId && item.type === "compaction" && item.trigger === "manual",
      ),
    );
    await send(agentId, maintenancePrefix + " continue after restart.");
    assert.equal((await snapshot(agentId)).persistence.nativeHandle, id);
    const followed = (await timeline(agentId)).entries;
    assert.ok(followed.some(({ item }) => item.type === "compaction" && item.trigger === "auto"));
    assert.equal(backend.maintenanceContinuations, 1);
    console.log(
      "PASS native manual summary, cold replay and follow-up using the same compacted SDK checkpoint",
    );

    await client.closeAgent(agentId);
    assert.equal((await snapshot(agentId)).status, "closed");
    await send(agentId, maintenancePrefix + " reopen after runtime close.");
    assert.equal((await snapshot(agentId)).persistence.nativeHandle, id);

    const beforeFork = await native();
    const beforeForkRuns = await nativeRuns();
    for (const mode of ["files", "both"]) {
      await assert.rejects(
        client.rewindAgent(agentId, user.item.messageId, mode),
        /does not support rewinding/,
      );
    }
    const fork = await cli(
      "agent",
      "fork",
      agentId,
      maintenancePrefix + " fork with the source transcript.",
      "--relationship",
      "detached",
      "--no-notify-on-finish",
      "--wait-timeout",
      "12s",
    );
    const branched = await snapshot(fork.agentId);
    assert.equal(branched.provider, "cursor-sdk");
    assert.notEqual(branched.persistence.nativeHandle, id);
    assert.equal(backend.maintenanceForks, 1);
    assert.deepEqual(await native(), beforeFork);
    assert.deepEqual(await nativeRuns(), beforeForkRuns);
    console.log(
      "PASS Paseo transcript fork opened a new Cursor conversation and unsupported rewind modes left the source intact",
    );

    const branchedPrompt = (await timeline(fork.agentId)).entries.findLast(
      ({ item }) => item.type === "user_message",
    );
    await client.rewindAgent(fork.agentId, branchedPrompt.item.messageId, "conversation");
    const rewound = await snapshot(fork.agentId);
    assert.notEqual(rewound.persistence.nativeHandle, branched.persistence.nativeHandle);
    assert.ok(
      !(await timeline(fork.agentId)).entries.some(
        ({ item }) =>
          item.type === "user_message" && item.messageId === branchedPrompt.item.messageId,
      ),
    );
    const rewoundHandle = rewound.persistence.nativeHandle;
    const keptRuns = (await nativeRuns(rewoundHandle)).items.length;
    await send(fork.agentId, maintenancePrefix + " continue after rewind.");
    assert.equal((await snapshot(fork.agentId)).persistence.nativeHandle, rewoundHandle);
    assert.equal((await nativeRuns(rewoundHandle)).items.length, keptRuns + 1);
    assert.deepEqual(await native(), beforeFork);
    assert.deepEqual(await nativeRuns(), beforeForkRuns);
    console.log(
      "PASS conversation rewind moved the fork to a new Cursor agent, the next prompt ran there, and the source stayed intact",
    );

    await client.archiveAgent(agentId);
    assert.deepEqual(await native(), beforeFork);
    const restored = await importAgent(id);
    assert.equal(restored.id, agentId);
    assert.equal(restored.persistence.nativeHandle, id);
    await client.deleteAgent(agentId);
    assert.deepEqual(await native(), beforeFork);
    assert.deepEqual(await nativeRuns(), beforeForkRuns);
    assert.ok((await list()).entries.some((entry) => entry.providerHandleId === id));
    console.log(
      "PASS Paseo close, archive, restore and delete preserved the original native conversation",
    );

    const localOptions = { cwd: workspace, store };
    await Agent.archive(id, localOptions);
    assert.equal((await native()).status, "archived");
    await Agent.unarchive(id, localOptions);
    assert.equal((await native()).status, "idle");
    assert.deepEqual(await nativeRuns(), beforeForkRuns);
    console.log(
      "PASS pinned native SDK archive and unarchive update local status and preserve runs",
    );
    await checkBackgroundShell({ client, send, workspace, workspaceId, model, native });
  } finally {
    await client.close();
  }
}
