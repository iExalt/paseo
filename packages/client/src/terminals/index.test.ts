import { expect, test } from "vitest";
import { createTerminalActions } from "./index.js";

test("an older host rejects terminal operations before sending requests", async () => {
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "older-host",
        hostname: null,
        version: null,
        features: {},
      }),
      createTerminal: unexpectedRequest,
      listTerminals: unexpectedRequest,
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    },
    unexpectedRequest,
  );

  await expect(terminals.create({ workspaceId: "wks_existing" })).rejects.toThrow(
    "Update the host",
  );
  await expect(terminals.list({ workspaceId: "wks_existing" })).rejects.toThrow("Update the host");
  const terminal = terminals.ref("terminal-existing");
  expect(terminal.current()).toBeNull();
  expect(() => terminal.write("text")).toThrow("Update the host");
  expect(() => terminal.sendKeys(["Enter"])).toThrow("Update the host");
  expect(() => terminal.capture()).toThrow("Update the host");
  await expect(terminal.kill()).rejects.toThrow("Update the host");
});

test("terminal snapshots preserve title and activity through create, list and refresh", async () => {
  const snapshot = {
    id: "term_test",
    workspaceId: "wks_test",
    cwd: "/repo",
    name: "shell",
    title: "build",
    activity: { state: "working" as const, changedAt: 42 },
  };
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "host",
        hostname: null,
        version: null,
        features: { workspaceTerminals: true },
      }),
      createTerminal: async () => ({ requestId: "create", terminal: snapshot, error: null }),
      listTerminals: async () => ({ requestId: "list", terminals: [snapshot] }),
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    },
    async () => "/repo",
  );
  const handle = await terminals.create({ workspaceId: "wks_test" });
  expect(handle.current()).toEqual(snapshot);
  expect((await terminals.list()).entries).toEqual([snapshot]);
  expect(await handle.refresh()).toEqual(snapshot);
});
