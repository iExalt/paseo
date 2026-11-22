import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { model } from "./backend.mjs";
import { windowsJobMembers } from "./windows-job-members.mjs";

async function eventually(label, probe) {
  const deadline = performance.now() + 12_000;
  do {
    const result = await probe();
    if (result) return result;
    await delay(30);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function optional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}

const windows = process.platform === "win32";

async function processIdentity(pid) {
  if (windows) {
    try {
      process.kill(pid, 0);
      return { state: "running" };
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
  }
  const stat = await optional(`/proc/${pid}/stat`);
  if (!stat) return;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], birth: fields[19] };
}

export async function checkOwnedRecovery({
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
  const { JsonlLocalAgentStore } = require("@cursor/sdk");
  const store = new JsonlLocalAgentStore(join(paseoHome, "cursor-sdk"));
  const socket = listener();
  const client = new DaemonClient({
    url: `ws://${socket}/ws`,
    appVersion: "0.32.1",
    clientId: "cursor-owned-recovery",
    reconnect: { enabled: true, baseDelayMs: 25, maxDelayMs: 100 },
  });
  const statuses = [];
  const unsubscribe = client.subscribeConnectionStatus(({ status }) => statuses.push(status));
  const hold = join(workspace, "owner-hold");
  const leafPath = join(workspace, "owner-leaf.pid");
  const holdLease = join(workspace, "owner-hold-lease");
  const sentinel = join(workspace, "owner-late-effect");
  const finish = join(workspace, "owner-finish");
  const endShell = join(workspace, "owner-end-shell");
  const backgroundStart = join(workspace, "owner-background-start");
  const backgroundRelease = join(workspace, "owner-background-release");
  const backgroundPidFile = join(workspace, "owner-background.pid");
  const configPath = join(paseoHome, "config.json");
  const history = (id) => client.fetchAgentTimeline(id, { limit: 100, timeout: 8000 });
  const nativeId = async (id) => (await client.fetchAgent(id))?.agent.persistence?.nativeHandle;
  const send = (id, text, messageId = randomUUID()) =>
    client.sendAgentMessage(id, text, { messageId });
  let leaf;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const unrelatedSpawned = once(unrelated, "spawn");
  const unrelatedExited = once(unrelated, "exit");

  async function turnRecord(agentId, messageId) {
    const digest = createHash("sha256").update(agentId).digest("hex");
    const directory = join(paseoHome, "cursor-sdk", "paseo-turns", digest);
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".turn.json")) continue;
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (record.user.clientMessageId === messageId) return record;
    }
  }

  async function checkLiveDomain(owner, child) {
    assert.ok(await processIdentity(child.pid), "The fixture leaf must still be alive");
    if (windows) {
      assert.equal(owner.backend, "windows-job");
      assert.equal(await optional(owner.receipt), undefined);
      const members = await windowsJobMembers(owner.generation);
      assert.ok(members.includes(child.pid));
      assert.ok(!members.includes(unrelated.pid));
      return;
    }
    assert.equal(owner.backend, "linux-systemd");
    assert.equal((await processIdentity(child.pid))?.birth, child.birth);
    assert.ok(
      (await readFile(`/proc/${child.pid}/cgroup`, "utf8"))
        .split("\n")
        .includes(`0::${owner.cgroup}`),
    );
    assert.match(
      await readFile(`/sys/fs/cgroup${owner.cgroup}/cgroup.events`, "utf8"),
      /^populated 1$/m,
    );
  }

  async function releaseLeaf(owner, child) {
    if (windows) {
      await writeFile(finish, "exit safely");
      await eventually(
        "named Windows Job receipt",
        async () => (await optional(owner.receipt)) === owner.generation,
      );
      assert.equal(await processIdentity(child.pid), undefined);
      return;
    }
    assert.equal((await processIdentity(child.pid))?.state, "T");
    process.kill(child.pid, "SIGKILL");
    await eventually("old execution domain empty", async () => {
      const events = await optional(`/sys/fs/cgroup${owner.cgroup}/cgroup.events`);
      return events === undefined || /^populated 0$/m.test(events);
    });
  }

  async function cycle(resumeOnStartup) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.agents.resumeOnStartup = resumeOnStartup;
    await writeFile(configPath, JSON.stringify(config));
    await rm(leafPath, { force: true });
    await rm(sentinel, { force: true });
    await rm(finish, { force: true });
    await rm(endShell, { force: true });
    await rm(holdLease, { force: true, recursive: true });
    await writeFile(hold, "held");
    const { id } = await client.createAgent({
      provider: "cursor-sdk",
      workspaceId,
      cwd: workspace,
      model,
      modeId: "unrestricted",
    });
    const messageId = randomUUID();
    const prompt = `Hold my detached tool (${resumeOnStartup}).`;
    assert.equal((await send(id, prompt, messageId)).disposition, "turn_started");
    leaf = await eventually("detached shell write-ahead marker", async () => {
      const pid = Number(await optional(leafPath));
      const identity = pid > 1 && (await processIdentity(pid));
      return identity && { pid, ...identity };
    });
    const agentId = await nativeId(id);
    const saved = await turnRecord(agentId, messageId);
    assert.ok(saved?.executionOwner, "SDK dispatch did not enroll an execution owner");
    assert.ok(saved.executionRunIds.includes(saved.nativeRunId));
    const owner = saved.executionOwner;
    await checkLiveDomain(owner, leaf);
    await eventually("warm tool card", async () =>
      (await history(id)).entries.some(
        ({ item }) => item.type === "tool_call" && item.status === "running",
      ),
    );
    if (!windows) {
      process.kill(leaf.pid, "SIGSTOP");
      await eventually(
        "stopped leaf",
        async () => (await processIdentity(leaf.pid))?.state === "T",
      );
    }
    const runCount = backend.runs;
    const statusIndex = statuses.length;
    await stopDaemon("SIGKILL");
    await eventually("disconnected client", () =>
      statuses.slice(statusIndex).includes("disconnected"),
    );
    await startDaemon({ listen: socket });
    await eventually(
      "reconnected client",
      () => client.isConnected && statuses.slice(statusIndex).includes("connected"),
    );
    const cold = await history(id);
    if (windows) {
      await writeFile(endShell, "shell exits independently");
      await eventually("only the detached leaf remains in the Job", async () => {
        const members = await windowsJobMembers(owner.generation);
        return members.length === 1 && members[0] === leaf.pid;
      });
    }
    assert.ok(
      cold.entries.some(
        ({ turnId, item }) =>
          turnId === saved.id && item.type === "user_message" && item.clientMessageId === messageId,
      ),
    );
    assert.ok(
      cold.entries.some(({ turnId, item }) => turnId === saved.id && item.type === "tool_call"),
    );
    await assert.rejects(
      send(id, "Do not dispatch while the old owner still lives."),
      /live execution owner|could still be running/,
    );
    assert.equal(backend.runs, runCount);
    await checkLiveDomain(owner, leaf);
    console.log(
      JSON.stringify({
        resumeOnStartup,
        checkpoint: "replacement refuses live detached tool",
        turnId: saved.id,
        joined: saved.joined === true,
      }),
    );
    await releaseLeaf(owner, leaf);
    leaf = undefined;
    await rm(hold, { force: true });
    assert.equal(await optional(sentinel), undefined);
    assert.ok(await processIdentity(unrelated.pid));
    const nextId = randomUUID();
    assert.equal(
      (await send(id, "Continue this same chat after quiescence.", nextId)).disposition,
      "turn_started",
    );
    assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
    assert.equal(await nativeId(id), agentId);
    assert.equal(backend.runs, runCount + 1);
    assert.equal(
      (await store.runs.get({ agentId, runId: saved.nativeRunId }))?.status,
      "cancelled",
    );
    const repaired = await turnRecord(agentId, messageId);
    assert.equal(repaired.joined, true);
    assert.equal(repaired.terminal.code, "cursor_sdk_run_interrupted");
    const replay = await history(id);
    const matching = (key) =>
      replay.entries.filter(
        ({ item }) => item.type === "user_message" && item.clientMessageId === key,
      );
    assert.equal(matching(messageId).length, 1);
    assert.equal(matching(messageId)[0].turnId, saved.id);
    assert.equal(matching(nextId).length, 1);
    assert.notEqual(matching(nextId)[0].turnId, saved.id);
    console.log(
      `PASS same Paseo and native chat IDs after hard death and proven owner exit (resumeOnStartup=${resumeOnStartup})`,
    );
  }

  const generationOf = (owner) => (windows ? owner.generation : owner.unit);

  async function stopLaterOwner(id, agentId, previous, backgroundPid) {
    await rm(holdLease, { force: true, recursive: true });
    await rm(leafPath, { force: true });
    await rm(sentinel, { force: true });
    await rm(finish, { force: true });
    await rm(endShell, { force: true });
    await writeFile(hold, "held until Stop");
    const activeId = randomUUID();
    const queuedId = randomUUID();
    await send(id, "Hold this later owned turn until stopped.", activeId);
    leaf = await eventually("later run's detached shell", async () => {
      const pid = Number(await optional(leafPath));
      const identity = pid > 1 && (await processIdentity(pid));
      return identity && { pid, ...identity };
    });
    const active = await turnRecord(agentId, activeId);
    assert.notEqual(generationOf(active.executionOwner), generationOf(previous.executionOwner));
    await checkLiveDomain(active.executionOwner, leaf);
    const beforeQueue = backend.runs;
    const queued = await client.sendAgentMessage(id, "Run this once after Stop.", {
      activeTurnBehavior: "queue",
      messageId: queuedId,
    });
    assert.equal(queued.disposition, "queued");
    const start = performance.now();
    assert.equal(await client.cancelAgent(id), true);
    const runtimeMs = Math.round(performance.now() - start);
    assert.ok(runtimeMs < 2500);
    const end = await processIdentity(leaf.pid);
    assert.ok(!end || end.state === "Z");
    leaf = undefined;
    assert.equal(await optional(sentinel), undefined);
    assert.ok(
      await processIdentity(backgroundPid),
      "Canceling the new domain must preserve the old background task.",
    );
    assert.ok(await processIdentity(unrelated.pid));
    await eventually("queued turn completed exactly once", async () => {
      const page = await history(id);
      const rows = page.entries.filter(
        ({ item }) => item.type === "user_message" && item.clientMessageId === queuedId,
      );
      return page.agent.status === "idle" && rows.length === 1 && backend.runs === beforeQueue + 1;
    });
    await rm(hold, { force: true });
    console.log(
      `PASS Stop joined only its own execution generation in ${runtimeMs}ms, then Queue dispatched once`,
    );
  }

  async function backgroundCanary() {
    await writeFile(backgroundStart, "launch intentional background worker");
    const { id } = await client.createAgent({
      provider: "cursor-sdk",
      workspaceId,
      cwd: workspace,
      model,
      modeId: "unrestricted",
    });
    const firstId = randomUUID();
    await send(id, "Start a background helper and finish.", firstId);
    assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
    const agentId = await nativeId(id);
    const first = await turnRecord(agentId, firstId);
    assert.equal(first.joined, true);
    const pid = await eventually(
      "intentional background PID",
      async () => Number(await optional(backgroundPidFile)) || undefined,
    );
    assert.ok(await processIdentity(pid));
    const original = await store.runEvents.list({ runId: first.nativeRunId });
    await checkLiveDomain(first.executionOwner, { pid, ...(await processIdentity(pid)) });
    await rm(backgroundStart, { force: true });
    const nextId = randomUUID();
    await send(id, "Continue while the background helper stays alive.", nextId);
    assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
    const next = await turnRecord(agentId, nextId);
    assert.notEqual(generationOf(next.executionOwner), generationOf(first.executionOwner));
    assert.ok(await processIdentity(pid));
    await stopLaterOwner(id, agentId, first, pid);
    assert.deepEqual(await store.runEvents.list({ runId: first.nativeRunId }), original);
    await writeFile(backgroundRelease, "finish background work");
    await eventually("background process exited after its own release", async () => {
      const state = await processIdentity(pid);
      return !state || state.state === "Z";
    });
    console.log(
      "PASS natural success kept its intentional background process across the next same-chat turn without writing old SDK events",
    );
  }

  try {
    await client.connect();
    await unrelatedSpawned;
    if (windows) {
      await writeFile(
        join(workspace, "owner-leaf.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { existsSync, writeFileSync } from "node:fs";',
          'import { setTimeout as delay } from "node:timers/promises";',
          'if (process.argv[2] === "launch" || process.argv[2] === "start-background") {',
          '  const child = spawn(process.execPath, [import.meta.filename, process.argv[2] === "launch" ? "leaf" : "background"], { detached: true, windowsHide: true, stdio: "ignore" });',
          "  child.unref();",
          '} else if (process.argv[2] === "background") {',
          '  writeFileSync("owner-background.pid", String(process.pid));',
          '  while (!existsSync("owner-background-release")) await delay(30);',
          "} else {",
          '  writeFileSync("owner-leaf.pid", String(process.pid));',
          '  while (existsSync("owner-hold") && !existsSync("owner-finish")) await delay(30);',
          '  if (!existsSync("owner-finish")) writeFileSync("owner-late-effect", "late");',
          "}",
        ].join("\n"),
      );
    }
    await writeFile(
      join(workspace, "cursor-canary.sh"),
      [
        "set -eu",
        "if test -f owner-background-start; then",
        windows
          ? "  node owner-leaf.mjs start-background"
          : '  setsid /bin/sh -c \'printf "%s" "$$" > owner-background.pid; while ! test -f owner-background-release; do sleep 0.05; done\' </dev/null >/dev/null 2>&1 &',
        "fi",
        "if test -f owner-hold && mkdir owner-hold-lease 2>/dev/null; then",
        ...(windows
          ? [
              "  node owner-leaf.mjs launch",
              "  while test -f owner-hold && ! test -f owner-finish && ! test -f owner-end-shell; do sleep 0.05; done",
            ]
          : [
              '  setsid /bin/sh -c \'printf "%s" "$$" > owner-leaf.pid; while test -f owner-hold; do sleep 0.05; done; printf late > owner-late-effect\' &',
              "  wait $!",
            ]),
        "fi",
        `printf '%s' '${canary}' > cursor-canary.txt`,
        `printf '%s' '${canary}'`,
      ].join("\n"),
    );
    await cycle(false);
    await cycle(true);
    await backgroundCanary();
  } finally {
    unsubscribe();
    await client.close();
    if (leaf && windows) await writeFile(finish, "exit safely");
    else if (leaf && (await processIdentity(leaf.pid))?.birth === leaf.birth)
      process.kill(leaf.pid, "SIGKILL");
    await rm(hold, { force: true });
    await writeFile(backgroundRelease, "finish background work");
    unrelated.kill();
    await unrelatedExited;
  }
}
