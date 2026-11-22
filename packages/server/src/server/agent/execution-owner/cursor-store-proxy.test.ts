import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLocalAgentStore, type LocalAgentRunDocument } from "@cursor/sdk";
import { afterEach, expect, test, vi } from "vitest";
import { serveCursorStore } from "./cursor-store-proxy.js";
import { ownerDeferred } from "./owner-channel.js";

const agentId = "owned-agent";
const runId = "owned-run";
const running: LocalAgentRunDocument = {
  agentId,
  runId,
  status: "running",
  turnNumber: 1,
  createdAt: 1,
  updatedAt: 1,
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createStore(): Promise<JsonlLocalAgentStore> {
  const root = await mkdtemp(join(tmpdir(), "cursor-owner-store-"));
  roots.push(root);
  const store = new JsonlLocalAgentStore(root);
  await store.agents.create({
    agent: { agentId, cwd: root, status: "idle", createdAt: 1, updatedAt: 1 },
  });
  return store;
}

test("disconnect during write-ahead binding fences the pending native mutation", async () => {
  const store = await createStore();
  const bound = ownerDeferred<void>();
  const proceed = ownerDeferred<void>();
  let connected = true;
  const owner = serveCursorStore(
    store,
    agentId,
    () => connected,
    async (id) => {
      expect(id).toBe(runId);
      bound.resolve();
      await proceed.promise;
    },
  );
  const pending = owner.handle("runs.create", { run: running });
  const rejected = expect(pending).rejects.toThrow("owner was disconnected");
  await bound.promise;
  connected = false;
  const drained = owner.close();
  proceed.resolve();
  await Promise.all([rejected, drained]);
  expect(await store.runs.get({ agentId, runId })).toBeNull();
});

test("drains a committed SDK mutation even when its reply cannot reach the old owner", async () => {
  const store = await createStore();
  const written = ownerDeferred<void>();
  const reply = ownerDeferred<void>();
  const original = store.runs.create.bind(store.runs);
  vi.spyOn(store.runs, "create").mockImplementation(async (input) => {
    const value = await original(input);
    written.resolve();
    await reply.promise;
    return value;
  });
  let connected = true;
  const owner = serveCursorStore(
    store,
    agentId,
    () => connected,
    async () => {},
  );
  const pending = owner.handle("runs.create", { run: running });
  await written.promise;
  connected = false;
  const drained = owner.close();
  reply.resolve();
  await Promise.all([pending, drained]);
  expect(await store.runs.get({ agentId, runId })).toMatchObject({ status: "running" });
  await expect(
    owner.handle("runs.update", { run: { ...running, status: "finished" } }),
  ).rejects.toThrow("owner was disconnected");
});
