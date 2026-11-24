import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Open the Cursor SDK store a daemon under test writes. Current daemons migrate
 * the JSONL tables into SQLite on first use; older daemons (baseline mode) and
 * not-yet-migrated homes still use the JSONL tables.
 */
export async function openFixtureStore(require, root) {
  const sqliteRoot = join(root, "sqlite");
  if (!existsSync(join(sqliteRoot, "paseo-migration.json"))) {
    const { JsonlLocalAgentStore } = require("@cursor/sdk");
    return new JsonlLocalAgentStore(root);
  }
  const { SqliteLocalAgentStore } = require("@cursor/sdk/sqlite");
  return SqliteLocalAgentStore.open({ workspaceRef: "paseo", stateRoot: sqliteRoot });
}

/** A store whose every call reopens the current store, so a migration mid-run is followed. */
export function fixtureStore(require, root) {
  const table = (name) =>
    new Proxy(
      {},
      {
        get:
          (_, method) =>
          async (...args) =>
            (await openFixtureStore(require, root))[name][method](...args),
      },
    );
  return {
    agents: table("agents"),
    runs: table("runs"),
    runEvents: table("runEvents"),
    checkpoints: table("checkpoints"),
  };
}
