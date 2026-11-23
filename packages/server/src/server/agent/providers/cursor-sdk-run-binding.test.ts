import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { expect, test } from "vitest";
import { createCursorRunBinding } from "./cursor-sdk-run-binding.js";

const time = Date.parse("2026-11-23T10:00:00Z");
const usage = { inputTokens: 7, outputTokens: 2, totalTokens: 9 };

test("a stale cancellation keeps the usage the run loop wrote", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-run-binding-"));
  try {
    const { store } = createCursorRunBinding(new sdk.JsonlLocalAgentStore(root));
    const running: sdk.LocalAgentRunDocument = {
      agentId: "agent",
      runId: "run",
      turnNumber: 1,
      status: "running",
      createdAt: time,
      updatedAt: time,
      startedAt: time,
      endedAt: null,
      startCheckpointRef: null,
      latestCheckpointRef: null,
    };
    await store.runs.create({ run: running });

    // Run.cancel() and the run loop both read the running row, then write.
    const cancelled = { ...running, status: "cancelled" as const, endedAt: time + 1 };
    await Promise.all([
      store.runs.update({ run: { ...cancelled, usage } }),
      store.runs.update({ run: { ...cancelled, usage: null } }),
    ]);

    const stored = await store.runs.get({ agentId: "agent", runId: "run" });
    expect(stored).toMatchObject({ status: "cancelled", usage });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
