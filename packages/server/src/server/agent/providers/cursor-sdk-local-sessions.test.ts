import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, test } from "vitest";
import {
  listCursorLocalSessions,
  readCursorLocalSessionForImport,
} from "./cursor-sdk-local-sessions.js";

test("only lists saved native sessions whose latest run is eligible for direct import", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-local-sessions-"));
  try {
    const cwd = await realpath(root);
    const store = new JsonlLocalAgentStore(join(root, "native"));
    const finished = "agent-72a9db96-ad2c-4e58-b265-af59f9bb02bf";
    const canceled = "agent-fec0b724-c78c-4a8b-8890-eefb784fdac1";
    for (const agentId of [finished, canceled]) {
      await store.agents.create({
        agent: {
          agentId,
          cwd,
          status: "idle",
          latestCheckpoint: { schemaVersion: 1, rootBlobId: "fixture" },
          createdAt: 100,
          updatedAt: 300,
        },
      });
      await store.runs.create({
        run: {
          agentId,
          runId: "run-original-" + agentId,
          status: "finished",
          turnNumber: 1,
          model: { id: "fixture-model" },
          createdAt: 100,
          updatedAt: 200,
        },
      });
    }
    await store.runs.create({
      run: {
        agentId: canceled,
        runId: "run-canceled",
        status: "cancelled",
        turnNumber: 2,
        createdAt: 200,
        updatedAt: 300,
      },
    });

    expect(
      (await listCursorLocalSessions(store, { cwd })).map((row) => row.providerHandleId),
    ).toEqual([finished]);
    await expect(
      readCursorLocalSessionForImport(store, { cwd, providerHandleId: canceled }),
    ).rejects.toThrow("requires a finished Cursor SDK run");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
