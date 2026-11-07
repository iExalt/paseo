import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { terminalUpdateBlockers } from "./terminal-update-blockers.js";
import { writeTerminalWorkerRecord } from "./terminal-worker-record.js";
import type { TerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it("blocks live or unreadable terminal work, permits empty disconnect, and ignores reused PIDs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "update-blockers-"));
  directories.push(home);
  const record = {
    recordId: "fixture",
    pid: 12,
    bootId: null,
    createdAt: "birth",
    identity: { startedAt: "birth", commandLine: "node --paseo-terminal-worker fixture" },
    protocolVersion: 1,
    paseoVersion: "1.2.3",
    socketPath: "fixture",
    secret: "fixture",
    terminals: [{ id: "term", pid: 13, startedAt: "birth" }],
  };
  await writeTerminalWorkerRecord(home, record);
  const inspector: TerminalWorkerProcessInspector = {
    reportsSessions: false,
    inspect: async () => ({
      status: "alive",
      snapshot: {
        pid: 12,
        commandLine: "node --paseo-terminal-worker fixture",
        startedAt: "birth",
      },
    }),
    listProcesses: async () => [],
    readEnvironment: async () => null,
  };
  expect(await terminalUpdateBlockers(home, { inspector, allowEmptyWorkers: true })).toBe(true);
  record.terminals = [];
  await writeTerminalWorkerRecord(home, record);
  expect(await terminalUpdateBlockers(home, { inspector, allowEmptyWorkers: true })).toBe(false);
  expect(await terminalUpdateBlockers(home, { inspector })).toBe(true);
  inspector.inspect = async () => ({
    status: "alive",
    snapshot: { pid: 12, commandLine: "other", startedAt: "another birth" },
  });
  expect(await terminalUpdateBlockers(home, { inspector })).toBe(false);
  inspector.inspect = async () => ({ status: "error", error: new Error("inspection denied") });
  expect(await terminalUpdateBlockers(home, { inspector })).toBe(true);
  await writeFile(path.join(home, "terminal-worker", "12.json"), "broken");
  expect(await terminalUpdateBlockers(home, { inspector })).toBe(true);
});
