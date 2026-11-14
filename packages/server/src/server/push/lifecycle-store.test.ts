import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationLifecycleStore } from "./lifecycle-store.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function location() {
  const home = mkdtempSync(join(tmpdir(), "paseo-lifecycle-"));
  homes.push(home);
  return join(home, "episodes.json");
}
test("stable episodes survive restart, read closes attention only, a later finish opens B", async () => {
  const file = location();
  const store = new NotificationLifecycleStore(file);
  await store.observe("agent", { attention: true, questions: true });
  const a = (await store.active()).find((entry) => entry.lane === "attention")!;
  await store.observe("agent", { attention: true, questions: true });
  const recovered = new NotificationLifecycleStore(file);
  expect(await recovered.active()).toEqual(await store.active());
  await recovered.observe("agent", { attention: false, questions: true });
  expect((await recovered.active()).map((entry) => entry.lane)).toEqual(["question"]);
  expect(await recovered.pending()).toEqual([a]);
  await recovered.observe("agent", { attention: true });
  expect(
    (await recovered.active()).find((entry) => entry.lane === "attention")!.episodeId,
  ).not.toBe(a.episodeId);
});
test("unknown pending state never resolves a question, archive/delete closes both lanes", async () => {
  const store = new NotificationLifecycleStore(location());
  await store.observe("agent", { attention: true, questions: true });
  await store.observe("agent", { attention: false });
  expect((await store.active()).map((entry) => entry.lane)).toEqual(["question"]);
  await store.observe("agent", { attention: false, questions: true });
  expect(await store.active()).toHaveLength(1);
  await store.observe("agent", { attention: false, removed: true });
  expect(await store.active()).toEqual([]);
  expect(await store.pending()).toHaveLength(2);
});
test("failed async persistence leaves old state and does not poison later queued operations", async () => {
  let fail = true;
  const store = new NotificationLifecycleStore(location(), Date.now, async () => {
    if (fail) throw new Error("disk failure");
  });
  await expect(store.observe("agent", { attention: true })).rejects.toThrow("disk failure");
  expect(await store.active()).toEqual([]);
  expect(await store.pending()).toEqual([]);
  fail = false;
  await store.observe("agent", { attention: true });
  expect(await store.active()).toHaveLength(1);
});
test("startup closes deleted source episodes and accepted outbox entries are explicitly removed", async () => {
  const file = location();
  const store = new NotificationLifecycleStore(file);
  await store.observe("deleted", { attention: true });
  const recovered = new NotificationLifecycleStore(file);
  await recovered.reconcile([]);
  expect(await recovered.active()).toEqual([]);
  expect(await recovered.pending()).toHaveLength(1);
  await recovered.delivered((await recovered.pending())[0]!.episodeId);
  expect(await new NotificationLifecycleStore(file).pending()).toEqual([]);
});
