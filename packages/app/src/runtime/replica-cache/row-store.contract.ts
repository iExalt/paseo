import { beforeEach, describe, expect, it } from "vitest";
import type { ReplicaRow, ReplicaRowStore } from "./row-store";

export interface ReplicaRowStoreHarness {
  store: ReplicaRowStore;
  openWithSchemaVersion(schemaVersion: number): Promise<ReplicaRowStore>;
}

export type CreateReplicaRowStoreHarness = () => Promise<ReplicaRowStoreHarness>;

const ALL_KINDS: ReplicaRow["kind"][] = ["agent", "checkpoint", "project", "timeline", "workspace"];

function row(serverId: string, kind: ReplicaRow["kind"], id: string, payload: string): ReplicaRow {
  return { serverId, kind, id, payload };
}

/** Every stored row grouped by host: the index names the hosts, read() returns their payloads. */
async function readStore(
  store: ReplicaRowStore,
): Promise<{ serverId: string; rows: ReplicaRow[] }[]> {
  const index = await store.readIndex();
  return Promise.all(
    index.map(async ({ serverId }) => ({ serverId, rows: await store.read(serverId, ALL_KINDS) })),
  );
}

export function runReplicaRowStoreContract(
  engineName: string,
  createHarness: CreateReplicaRowStoreHarness,
): void {
  describe(`${engineName} replica row store`, () => {
    let harness: ReplicaRowStoreHarness;
    let store: ReplicaRowStore;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
      await store.open();
    });

    it("reads an empty store", async () => {
      expect(await readStore(store)).toEqual([]);
    });

    it("round-trips opaque payloads grouped by server", async () => {
      await store.apply({
        upserts: [
          row("server-b", "checkpoint", "singleton", '{"cursor":2}'),
          row("server-a", "agent", "agent-1", '{"status":"running"}'),
          row("server-a", "timeline", "singleton", "not parsed by the row store"),
        ],
        deletes: [],
      });

      expect(await readStore(store)).toEqual([
        {
          serverId: "server-a",
          rows: [
            row("server-a", "agent", "agent-1", '{"status":"running"}'),
            row("server-a", "timeline", "singleton", "not parsed by the row store"),
          ],
        },
        {
          serverId: "server-b",
          rows: [row("server-b", "checkpoint", "singleton", '{"cursor":2}')],
        },
      ]);
    });

    it("indexes each row's UTF-8 size without its payload", async () => {
      await store.apply({
        upserts: [
          row("server-b", "agent", "empty", ""),
          row("server-a", "timeline", "ascii", "abc"),
          row("server-a", "agent", "two-byte", "é"),
          row("server-a", "project", "three-byte", "€"),
          row("server-a", "workspace", "four-byte", "😀"),
          row("server-a", "checkpoint", "mixed", "aé€😀"),
        ],
        deletes: [],
      });

      expect(await store.readIndex()).toStrictEqual([
        {
          serverId: "server-a",
          rows: [
            { serverId: "server-a", kind: "agent", id: "two-byte", bytes: 2 },
            { serverId: "server-a", kind: "checkpoint", id: "mixed", bytes: 10 },
            { serverId: "server-a", kind: "project", id: "three-byte", bytes: 3 },
            { serverId: "server-a", kind: "timeline", id: "ascii", bytes: 3 },
            { serverId: "server-a", kind: "workspace", id: "four-byte", bytes: 4 },
          ],
        },
        {
          serverId: "server-b",
          rows: [{ serverId: "server-b", kind: "agent", id: "empty", bytes: 0 }],
        },
      ]);
    });

    it("reads only requested kinds for one host", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "agent"),
          row("server-a", "timeline", "singleton", "timeline"),
          row("server-b", "agent", "agent-2", "other host"),
        ],
        deletes: [],
      });

      expect(await store.read("server-a", ["timeline"])).toEqual([
        row("server-a", "timeline", "singleton", "timeline"),
      ]);
      expect(await store.read("server-a", ["agent"], ["missing"])).toEqual([]);
    });

    it("overwrites an existing row on upsert", async () => {
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "old")],
        deletes: [],
      });
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "new")],
        deletes: [],
      });

      expect(await readStore(store)).toEqual([
        {
          serverId: "server-a",
          rows: [row("server-a", "agent", "agent-1", "new")],
        },
      ]);
    });

    it("deletes one row by its compound identity", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "same-id", "agent"),
          row("server-a", "workspace", "same-id", "workspace"),
        ],
        deletes: [],
      });
      await store.apply({
        upserts: [],
        deletes: [{ serverId: "server-a", kind: "agent", id: "same-id" }],
      });

      expect(await readStore(store)).toEqual([
        {
          serverId: "server-a",
          rows: [row("server-a", "workspace", "same-id", "workspace")],
        },
      ]);
    });

    it("rolls back the entire apply when one write fails", async () => {
      const invalidRow = {
        ...row("server-a", "agent", "invalid", "invalid"),
        serverId: undefined,
      } as unknown as ReplicaRow;

      await expect(
        store.apply({
          upserts: [row("server-a", "agent", "would-have-been-written", "payload"), invalidRow],
          deletes: [],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await readStore(store)).toEqual([]);
    });

    it("deletes every row belonging to one host", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "a"),
          row("server-a", "project", "project-1", "p"),
          row("server-b", "agent", "agent-2", "b"),
        ],
        deletes: [],
      });

      await store.deleteHost("server-a");

      expect(await readStore(store)).toEqual([
        { serverId: "server-b", rows: [row("server-b", "agent", "agent-2", "b")] },
      ]);
    });

    it("renames a host and lets moved rows replace target collisions", async () => {
      await store.apply({
        upserts: [
          row("temporary", "agent", "agent-1", "temporary-agent"),
          row("temporary", "project", "project-1", "temporary-project"),
          row("canonical", "agent", "agent-1", "canonical-agent"),
          row("canonical", "workspace", "workspace-1", "canonical-workspace"),
        ],
        deletes: [],
      });

      await store.renameHost("temporary", "canonical");

      expect(await readStore(store)).toEqual([
        {
          serverId: "canonical",
          rows: [
            row("canonical", "agent", "agent-1", "temporary-agent"),
            row("canonical", "project", "project-1", "temporary-project"),
            row("canonical", "workspace", "workspace-1", "canonical-workspace"),
          ],
        },
      ]);
    });

    it("clears all cached rows", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "a"),
          row("server-b", "agent", "agent-2", "b"),
        ],
        deletes: [],
      });

      await store.clear();

      expect(await readStore(store)).toEqual([]);
    });

    it("wipes cached rows when the schema version changes on open", async () => {
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "stale")],
        deletes: [],
      });

      const upgradedStore = await harness.openWithSchemaVersion(2);

      expect(await readStore(upgradedStore)).toEqual([]);
    });
  });
}
