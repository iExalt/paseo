import { fixtureStore } from "./fixture-store.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assistantText, model } from "./backend.mjs";

const literal =
  "<paseo_instructions>\nThis is literal user text.\n</paseo_instructions>\n\nRun the fixture.";
// A single-pixel PNG. The native loopback fixture processes the turn for real.
const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWkAAAAASUVORK5CYII=",
};

async function eventually(label, probe) {
  const deadline = Date.now() + 12_000;
  do {
    const result = await probe();
    if (result) return result;
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function runningPid(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

function comparable(page) {
  return page.entries.map(({ item, turnId }) => ({ item, turnId }));
}

export async function checkLifecycle({
  backend,
  listener,
  paseoHome,
  require,
  startDaemon,
  stopDaemon,
  workspace,
  workspaceId,
  canary,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const localStore = fixtureStore(require, join(paseoHome, "cursor-sdk"));

  const hold = join(workspace, "cursor-hold");
  const heldPidFile = join(workspace, "cursor-shell.pid");
  const lateEffect = join(workspace, "cursor-after-stop.txt");
  const lease = join(workspace, "cursor-hold-lease");
  const socket = listener();
  const client = new DaemonClient({
    url: `ws://${socket}/ws`,
    appVersion: "0.32.1",
    clientId: "cursor-parity-lifecycle",
    reconnect: { enabled: true, baseDelayMs: 25, maxDelayMs: 100 },
  });
  const connection = [];
  const unsubscribe = client.subscribeConnectionStatus(({ status }) => connection.push(status));
  const pages = (id, options) =>
    client.fetchAgentTimeline(id, { limit: 100, timeout: 8000, ...options });
  const create = () =>
    client.createAgent({
      provider: "cursor-sdk",
      workspaceId,
      cwd: workspace,
      model,
      modeId: "unrestricted",
    });
  const send = (id, text, options) =>
    client.sendAgentMessage(id, text, { messageId: randomUUID(), ...options });
  const nativeId = async (id) => (await client.fetchAgent(id))?.agent.persistence?.nativeHandle;
  const readTurn = async (agentId, runId) => {
    const key = createHash("sha256").update(agentId).digest("hex");
    const path = join(paseoHome, "cursor-sdk", "paseo-turns", key);
    const files = (await readdir(path)).filter((name) => name.endsWith(".turn.json"));
    const rows = await Promise.all(
      files.map(async (name) => JSON.parse(await readFile(join(path, name), "utf8"))),
    );
    return rows.find((row) => row.nativeRunId === runId);
  };
  const releaseHold = () => rm(hold, { force: true });
  const armHold = async () => {
    await rm(heldPidFile, { force: true });
    await rm(lateEffect, { force: true });
    await rm(lease, { force: true, recursive: true });
    await writeFile(hold, "");
  };
  const heldShell = async () =>
    eventually("owned local shell start", async () => {
      const pid = Number(await readOptional(heldPidFile));
      return Number.isInteger(pid) && pid > 1 && (await runningPid(pid)) ? pid : undefined;
    });
  const setStartup = async (enabled) => {
    const path = join(paseoHome, "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.agents.resumeOnStartup = enabled;
    await writeFile(path, JSON.stringify(config));
  };
  const restart = async (signal, options = {}) => {
    const eventIndex = connection.length;
    await stopDaemon(signal);
    await eventually("websocket disconnect", () =>
      connection.slice(eventIndex).includes("disconnected"),
    );
    await startDaemon({ listen: socket, ...options });
    await eventually(
      "same client reconnect",
      () => client.isConnected && connection.slice(eventIndex).includes("connected"),
    );
    await client.fetchAgents();
  };

  async function verifyCrash(resumeOnStartup) {
    await setStartup(resumeOnStartup);
    await armHold();
    const crashed = await create();
    const prompt = `Crash while shell is held (startup-resume: ${resumeOnStartup}).`;
    const originalId = randomUUID();
    assert.equal(
      (await send(crashed.id, prompt, { messageId: originalId })).disposition,
      "turn_started",
    );
    ownedPid = await heldShell();
    const id = await nativeId(crashed.id);
    const nativeBefore = await localStore.agents.get({ agentId: id });
    const runId = nativeBefore?.activeRunId;
    assert.ok(runId);
    await eventually("running shell projected before crash", async () =>
      (await pages(crashed.id)).entries.some(
        ({ item }) => item.type === "tool_call" && item.status === "running",
      ),
    );
    const backendRuns = backend.runs;
    let pendingStop;
    if (resumeOnStartup) {
      // SDK 1.4.2 sends SIGTERM and writes terminal metadata before its
      // shell/controller join. Freeze only this fixture's known shell PID.
      process.kill(ownedPid, "SIGSTOP");
      pendingStop = client.cancelAgent(crashed.id).catch(() => false);
      await eventually("SDK cancellation metadata before the live shell joined", async () => {
        const agent = await localStore.agents.get({ agentId: id });
        const run = await localStore.runs.get({ agentId: id, runId });
        return !agent?.activeRunId && run?.status === "cancelled" && (await runningPid(ownedPid));
      });
    }
    const journalAtCrash = await readTurn(id, runId);
    assert.ok(journalAtCrash, "Native run must be bound before the tools start");
    console.log(
      JSON.stringify({
        checkpoint: "before daemon SIGKILL",
        resumeOnStartup,
        sdkStatus: (await localStore.runs.get({ agentId: id, runId }))?.status,
        toolAlive: await runningPid(ownedPid),
        joined: journalAtCrash.joined === true,
        terminal: journalAtCrash.terminal?.status ?? null,
      }),
    );
    assert.equal(
      journalAtCrash.joined === true,
      false,
      "Journal released ownership while the held shell was still alive",
    );
    await restart("SIGKILL");
    if (pendingStop) assert.equal(await pendingStop, false);
    assert.ok(
      await runningPid(ownedPid),
      "Fixture must preserve the live tool across daemon death",
    );
    const cold = await eventually("interrupted history on replacement daemon", async () => {
      try {
        return await pages(crashed.id);
      } catch (error) {
        if (!/no confirmed shutdown/.test(error.message)) throw error;
        return undefined;
      }
    });
    const original = cold.entries.filter(
      ({ item }) =>
        item.type === "user_message" && item.clientMessageId === originalId && item.text === prompt,
    );
    assert.equal(original.length, 1);
    assert.ok(original[0].turnId);
    const tool = cold.entries.find(
      ({ item, turnId }) => turnId === original[0].turnId && item.type === "tool_call",
    );
    console.log(
      JSON.stringify({
        checkpoint: "cold timeline after daemon SIGKILL",
        resumeOnStartup,
        sameTurn: original[0].turnId === journalAtCrash.id,
        toolStatus: tool?.item.status ?? null,
        hasRecoveryNotice: cold.entries.some(
          ({ item }) => item.type === "error" && item.message.includes(runId),
        ),
      }),
    );
    assert.equal(original[0].turnId, journalAtCrash.id);
    assert.ok(tool, "Cold replay must retain the original tool card");
    if (!resumeOnStartup) assert.equal(tool.item.status, "running");
    assert.ok(
      cold.entries.some(
        ({ item, turnId }) =>
          turnId === original[0].turnId && item.type === "error" && item.message.includes(runId),
      ),
    );
    await assert.rejects(
      send(crashed.id, "Resend while shell remains live"),
      /could still be running/,
    );
    assert.ok(await runningPid(ownedPid));
    assert.equal(backend.runs, backendRuns);
    assert.equal(
      (await localStore.agents.get({ agentId: id }))?.activeRunId ?? null,
      resumeOnStartup ? null : runId,
    );
    assert.equal(
      (await localStore.runs.get({ agentId: id, runId }))?.status,
      resumeOnStartup ? "cancelled" : "running",
    );
    process.kill(ownedPid, resumeOnStartup ? "SIGKILL" : "SIGTERM");
    await eventually("owned shell to exit", async () => !(await runningPid(ownedPid)));
    ownedPid = undefined;
    await releaseHold();
    assert.equal(await readOptional(lateEffect), undefined);
    // The crashed daemon and its recorded shell are gone, so the chat recovers without a hand repair.
    const resumed = await eventually("crashed chat to accept a new prompt", async () => {
      try {
        return await send(crashed.id, "Continue after the held shell exited");
      } catch (error) {
        if (/could still be running/.test(error.message)) return undefined;
        throw error;
      }
    });
    assert.equal(resumed.disposition, "turn_started");
    assert.equal((await client.waitForFinish(crashed.id, 12_000)).status, "idle");
    assert.notEqual((await localStore.runs.get({ agentId: id, runId }))?.status, "running");
    console.log(
      `PASS live writer preserved across SIGKILL and readmission refused before SDK send, then recovered after the shell exited (resumeOnStartup=${resumeOnStartup})`,
    );
  }

  let ownedPid;
  try {
    await client.connect();
    await writeFile(
      join(workspace, "cursor-canary.sh"),
      [
        "set -eu",
        "if test -f cursor-hold && mkdir cursor-hold-lease 2>/dev/null; then",
        "  printf '%s' \"$$\" > cursor-shell.pid",
        "  while test -f cursor-hold; do sleep 0.05; done",
        "  printf 'A tool survived cancellation' > cursor-after-stop.txt",
        "fi",
        `printf '%s' '${canary}' > cursor-canary.txt`,
        `printf '%s' '${canary}'`,
      ].join("\n"),
    );

    const completed = await create();
    assert.equal((await send(completed.id, literal)).disposition, "turn_started");
    assert.equal((await client.waitForFinish(completed.id, 12_000)).status, "idle");
    const completedWarm = await pages(completed.id);
    assert.ok(
      completedWarm.entries.some(
        ({ item }) => item.type === "user_message" && item.text === literal,
      ),
    );
    assert.ok(
      completedWarm.entries.some(
        ({ item }) => item.type === "assistant_message" && item.text === assistantText,
      ),
    );

    await armHold();
    const canceled = await create();
    const imageMessageId = randomUUID();
    assert.equal(
      (await send(canceled.id, "", { images: [image], messageId: imageMessageId })).disposition,
      "turn_started",
    );
    ownedPid = await heldShell();
    const heldRuns = backend.runs;
    for (const mode of ["files", "both"]) {
      await assert.rejects(
        client.rewindAgent(canceled.id, imageMessageId, mode),
        /does not support rewinding/,
      );
    }
    assert.ok(await runningPid(ownedPid), "Unsupported rewind canceled the active shell");
    assert.equal(backend.runs, heldRuns);

    const queueId = randomUUID();
    const queued = await send(canceled.id, "Run the queued canary.", {
      activeTurnBehavior: "queue",
      messageId: queueId,
    });
    assert.equal(queued.disposition, "queued");
    const timed = performance.now();
    assert.equal(await client.cancelAgent(canceled.id), true);
    assert.ok(performance.now() - timed < 4000, "Stop exceeded cancellation and settlement bounds");
    assert.equal(
      await runningPid(ownedPid),
      false,
      "Stop returned with an owned shell still alive",
    );
    ownedPid = undefined;
    await releaseHold();
    assert.equal(await readOptional(lateEffect), undefined);
    const canceledWarm = await eventually("queued follow-up completion", async () => {
      const page = await pages(canceled.id);
      return page.agent.status === "idle" &&
        page.entries.some(
          ({ item }) => item.type === "assistant_message" && item.text === assistantText,
        )
        ? page
        : undefined;
    });
    const canceledRows = comparable(canceledWarm);
    const userRows = canceledRows.filter(({ item }) => item.type === "user_message");
    assert.deepEqual(
      userRows.map(({ item }) => [item.clientMessageId, item.text]),
      [
        [imageMessageId, ""],
        [queueId, "Run the queued canary."],
      ],
    );
    assert.notEqual(userRows[0].turnId, userRows[1].turnId);
    assert.ok(userRows.every(({ turnId }) => typeof turnId === "string" && turnId.length > 0));
    assert.ok(
      canceledRows.some(({ item }) => item.type === "tool_call" && item.status === "canceled"),
    );
    console.log(
      "PASS bounded Stop joined the shell, blocked the later side effect, and dispatched Queue once",
    );

    for (const outcome of ["delivered", "reverted"]) {
      await armHold();
      const steering = await create();
      assert.equal(
        (await send(steering.id, "Start a steerable shell.")).disposition,
        "turn_started",
      );
      ownedPid = await heldShell();
      const before = backend.runs;
      const text = `Native steer ${outcome}.`;
      const messageId = randomUUID();
      backend.expectSteer(text, outcome);
      const result = await send(steering.id, text, { messageId, activeTurnBehavior: "steer" });
      if (outcome === "delivered") assert.equal(result.disposition, "steered");
      else assert.equal(result.disposition, undefined);
      assert.deepEqual(backend.steers.at(-1), { text, outcome });
      await releaseHold();
      const expectedRuns = before + Number(outcome === "reverted");
      await eventually("native steer delivery or one fallback", async () => {
        const page = await pages(steering.id);
        return (
          backend.runs === expectedRuns &&
          page.agent.status === "idle" &&
          page.entries.some(
            ({ item }) => item.type === "user_message" && item.clientMessageId === messageId,
          )
        );
      });
      ownedPid = undefined;
      const rows = (await pages(steering.id)).entries.filter(
        ({ item }) => item.type === "user_message" && item.clientMessageId === messageId,
      );
      assert.equal(rows.length, 1);
      assert.equal(backend.runs, expectedRuns);
      console.log(`PASS pinned native steer ${outcome} with exactly one projected user message`);
    }

    await verifyCrash(false);
    await verifyCrash(true);

    assert.deepEqual(comparable(await pages(completed.id)), comparable(completedWarm));
    assert.deepEqual(comparable(await pages(canceled.id)), canceledRows);
    const canceledNativeId = await nativeId(canceled.id);
    const continuation = await send(
      canceled.id,
      "Continue this session after a confirmed Stop and restart.",
    );
    assert.equal(continuation.disposition, "turn_started");
    assert.equal((await client.waitForFinish(canceled.id, 12_000)).status, "idle");
    assert.equal(await nativeId(canceled.id), canceledNativeId);
    console.log("PASS same-agent send after confirmed Stop, daemon restart and cold replay");
    const continuedWarm = await pages(canceled.id);
    const replacement = await create();
    assert.equal(
      (await send(replacement.id, "Resume work in a fresh session after the old shell exited."))
        .disposition,
      "turn_started",
    );
    assert.equal((await client.waitForFinish(replacement.id, 12_000)).status, "idle");
    const unarchivedWarm = await pages(replacement.id);
    await client.archiveAgent(completed.id);
    await client.archiveAgent(canceled.id);
    await rename(workspace, workspace + "-removed");
    await restart("SIGTERM", { offline: true });
    // Each read-only operation is the first post-restart caller for its own
    // archived agent, so an earlier timeline fetch cannot mask a login check.
    const search = await client.searchAgentTimeline({
      agentId: completed.id,
      query: "This is literal user text",
    });
    assert.equal(search.locations.length, 1);
    assert.equal(search.locations[0].role, "user");
    const index = await client.listAgentTimelinePrompts(canceled.id);
    assert.ok(index.prompts.some(({ preview }) => preview.includes("Run the queued canary.")));
    const completeCold = await pages(completed.id, {
      direction: "after",
      cursor: completedWarm.endCursor,
    });
    const canceledCold = await pages(canceled.id, {
      direction: "after",
      cursor: canceledWarm.endCursor,
    });
    assert.equal(completeCold.reset || completeCold.staleCursor, true);
    assert.equal(canceledCold.reset || canceledCold.staleCursor, true);
    assert.deepEqual(comparable(await pages(replacement.id)), comparable(unarchivedWarm));
    assert.deepEqual(comparable(await pages(completed.id)), comparable(completedWarm));
    assert.deepEqual(comparable(await pages(canceled.id)), comparable(continuedWarm));
    console.log(
      "PASS completed and canceled history matched after WebSocket reconnect, sign-out, offline endpoints and removed cwd",
    );
  } finally {
    unsubscribe();
    await client.close();
    if (ownedPid && (await runningPid(ownedPid))) process.kill(ownedPid, "SIGKILL");
  }
}
