import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { model } from "./backend.mjs";

export const finishedUsage = {
  inputTokens: 12,
  cachedInputTokens: 2,
  cacheWriteTokens: 1,
  outputTokens: 3,
  reasoningTokens: 1,
  totalTokens: 15,
};

const stoppedUsage = {
  inputTokens: 7,
  cachedInputTokens: 1,
  cacheWriteTokens: 0,
  outputTokens: 2,
  reasoningTokens: 1,
  totalTokens: 9,
};

async function connect({ listener, require }) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const client = new DaemonClient({
    url: `ws://${listener()}/ws`,
    appVersion: "0.32.1",
    clientId: "cursor-parity-telemetry",
  });
  await client.connect();
  return client;
}

async function assertUsage({ client, args, id, usage, status }) {
  const snapshot = (await client.fetchAgent(id)).agent;
  assert.deepEqual(snapshot.lastUsage, usage);
  const { snapshot: cliSnapshot } = await args.cli("agent", "status", id);
  assert.deepEqual(cliSnapshot.lastUsage, usage);
  const { JsonlLocalAgentStore } = args.require("@cursor/sdk");
  const store = new JsonlLocalAgentStore(join(args.paseoHome, "cursor-sdk"));
  const page = await store.runs.list({ filter: { agentIds: [snapshot.persistence.nativeHandle] } });
  const run = page.items.findLast((entry) => entry.status === status);
  assert.ok(run, `Missing native ${status} run`);
  assert.deepEqual(run.usage, {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
  });
  return run.runId;
}

async function isToolProcessStarted(marker) {
  try {
    const pid = Number(await readFile(marker, "utf8"));
    return pid > 1 && (await readFile("/proc/" + pid + "/stat")).length > 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

async function waitForTool(client, id, ready) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const page = await client.fetchAgentTimeline(id, { limit: 100 });
    const running = page.entries.find(
      ({ item }) => item.type === "tool_call" && item.status === "running",
    );
    if (running && (await isToolProcessStarted(ready))) return running.item.callId;
    await delay(25);
  }
  throw new Error("Timed out waiting for the P8 held tool");
}

function toolCards(page) {
  return page.entries
    .filter(({ item }) => item.type === "tool_call")
    .map(({ item, turnId }) => ({ item, turnId }));
}

export async function checkCompletedTelemetry(args, id) {
  const client = await connect(args);
  try {
    const runId = await assertUsage({ client, args, id, usage: finishedUsage, status: "finished" });
    const cards = toolCards(await client.fetchAgentTimeline(id, { limit: 100 }));
    assert.equal(cards.length, 2);
    assert.ok(cards.every(({ item }) => item.callId.startsWith(runId + ":")));
    assert.equal(cards[0].turnId, cards[1].turnId);
    const inspect = await args.cli("agent", "inspect", id);
    assert.deepEqual(inspect.LastUsage, {
      InputTokens: 12,
      CachedTokens: 2,
      CacheWriteTokens: 1,
      OutputTokens: 3,
      ReasoningTokens: 1,
      TotalTokens: 15,
      CostUsd: null,
      ContextWindowUsedTokens: null,
      ContextWindowMaxTokens: null,
      ContextWindowPercent: null,
    });
    console.log(
      "PASS native finished usage matched WebSocket and CLI inspect; file progress settled to one card",
    );
  } finally {
    await client.close();
  }
}

export async function checkStoppedTelemetry(args) {
  let client = await connect(args);
  const held = join(args.workspace, "p8-held.sh");
  const ready = join(args.workspace, "p8-held.pid");
  await writeFile(held, 'printf "%s" "$$" > p8-held.pid\nwhile :; do sleep 0.05; done\n');
  try {
    const { id } = await client.createAgent({
      provider: "cursor-sdk",
      workspaceId: args.workspaceId,
      cwd: args.workspace,
      model,
      modeId: "unrestricted",
    });
    const send = (text) => client.sendAgentMessage(id, text, { messageId: randomUUID() });
    assert.equal((await send("PASEO_P8_STOPPED")).disposition, "turn_started");
    const callId = await waitForTool(client, id, ready);
    assert.equal(await client.cancelAgent(id), true);
    const runId = await assertUsage({ client, args, id, usage: stoppedUsage, status: "cancelled" });
    const cards = toolCards(await client.fetchAgentTimeline(id, { limit: 100 }));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].item.callId, callId);
    assert.ok(callId.startsWith(runId + ":"));
    assert.equal(cards[0].item.status, "canceled");
    const address = args.listener();
    await client.close();
    await args.stopDaemon("SIGTERM");
    // Simulate death before Paseo's asynchronously persisted snapshot updated.
    // The SDK row is the durable usage source. Touch only this fixture agent.
    const agentDir = join(args.paseoHome, "agents");
    const record = (await readdir(agentDir, { recursive: true })).find((name) =>
      name.endsWith("/" + id + ".json"),
    );
    assert.ok(record, "Paseo agent record missing before cold hydration");
    const path = join(agentDir, record);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.lastUsage = finishedUsage;
    await writeFile(path, JSON.stringify(stored));
    await args.startDaemon({ listen: address });
    client = await connect(args);
    assert.deepEqual(toolCards(await client.fetchAgentTimeline(id, { limit: 100 })), cards);
    await assertUsage({ client, args, id, usage: stoppedUsage, status: "cancelled" });
    assert.deepEqual(toolCards(await client.fetchAgentTimeline(id, { limit: 100 })), cards);
    await assertUsage({ client, args, id, usage: stoppedUsage, status: "cancelled" });
    assert.equal((await send("Retry after Stop.")).disposition, "turn_started");
    assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
    await assertUsage({ client, args, id, usage: finishedUsage, status: "finished" });
    assert.equal(toolCards(await client.fetchAgentTimeline(id, { limit: 100 })).length, 2);
    console.log(
      "PASS canceled tool and native partial usage survived restart and replay; same-session retry reports only its own tokens",
    );
  } finally {
    await client.close();
    await Promise.all([held, ready].map((path) => rm(path, { force: true })));
  }
}
