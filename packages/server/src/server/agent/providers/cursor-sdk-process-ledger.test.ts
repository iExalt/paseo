import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@cursor/sdk";
import { afterEach, beforeEach, expect, test } from "vitest";
import { assessProcessLedger, CursorProcessLedger } from "./cursor-sdk-process-ledger.js";
import { assertCursorRunReleased } from "./cursor-sdk-recovery.js";
import { CursorToolProcesses } from "./cursor-sdk-tool-processes.js";
import { CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

const posix = process.platform === "linux" || process.platform === "darwin";
let root: string;
let ledger: string;
let dead: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cursor-sdk-ledger-"));
  ledger = join(root, "turn.processes.ndjson");
  // A real process ID that has exited.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  dead = child.pid!;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(...entries: object[]) {
  await writeFile(ledger, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

const owner = (pid: number, tracing = true) => ({
  owner: { host: hostname(), pid, startedAt: Date.now() - 1_000, tracing },
});

test.skipIf(!posix)("releases a turn whose daemon and recorded shells are gone", async () => {
  const shell = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
  await once(shell, "exit");
  await write(
    owner(dead),
    { intent: 1 },
    { intent: 1, pgid: shell.pid },
    { intent: 2 },
    {
      intent: 2,
      failed: true,
    },
  );

  expect(await assessProcessLedger(ledger)).toEqual({ released: true });
});

test.skipIf(!posix)("blocks while a recorded shell group is still running", async () => {
  const shell = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  try {
    await write(owner(dead), { intent: 1 }, { intent: 1, pgid: shell.pid });
    expect(await assessProcessLedger(ledger)).toEqual({
      released: false,
      reason: `still has shell process group ${shell.pid}`,
    });
  } finally {
    process.kill(-shell.pid!, "SIGKILL");
  }
});

test.each([
  ["no ledger", async () => {}, "has no record of its tool processes"],
  [
    "a torn final record",
    async () => writeFile(ledger, `${JSON.stringify(owner(1 << 30))}\n{"intent":`),
    "has an unreadable process record",
  ],
  [
    "an owner that could not observe spawns",
    async () => write(owner(1 << 30, false)),
    "ran where Paseo could not observe its shells",
  ],
  [
    "a shell started without a recorded group",
    async () => write(owner(1 << 30), { intent: 1 }),
    "started a shell whose process group was never recorded",
  ],
  [
    "a shell no turn could claim",
    async () => write(owner(1 << 30), { unattributed: true }),
    "started a shell Paseo could not attribute",
  ],
  ["this daemon's own turn", async () => write(owner(process.pid)), "belongs to this daemon"],
])("blocks a turn with %s", async (_name, seed, reason) => {
  await seed();
  expect(await assessProcessLedger(ledger)).toEqual({ released: false, reason });
});

test("blocks while the owning daemon's process ID is alive", async () => {
  await write(owner(process.ppid));
  expect(await assessProcessLedger(ledger)).toEqual({
    released: false,
    reason: `may still be running in process ${process.ppid}`,
  });
});

test("blocks a turn recorded on another host", async () => {
  await write({ owner: { host: "elsewhere", pid: 1 << 30, startedAt: 0, tracing: true } });
  expect(await assessProcessLedger(ledger)).toEqual({
    released: false,
    reason: "ran on another host (elsewhere)",
  });
});

test.skipIf(!posix)("records a scoped shell before it starts and its group after", async () => {
  const processes = new CursorToolProcesses(new CursorProcessLedger(ledger, true));
  const other = new CursorProcessLedger(join(root, "other.processes.ndjson"), true);
  await processes.ledger!.open();
  await other.open();
  try {
    const shell = processes.scope(() =>
      spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" }),
    );
    await once(shell, "exit");
    const unscoped = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    await once(unscoped, "exit");

    const lines = (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      { intent: 1 },
      { intent: 1, pgid: shell.pid },
      { unattributed: true },
    ]);
    expect(await readFile(join(root, "other.processes.ndjson"), "utf8")).toContain(
      '{"unattributed":true}',
    );
  } finally {
    processes.close();
    other.close();
  }
});

test("closes a crashed daemon's turn as interrupted once its ledger is released", async () => {
  const store = new sdk.JsonlLocalAgentStore(root);
  const agentId = "agent-crashed";
  const runId = "run-crashed";
  const time = Date.now() - 60_000;
  await store.agents.create({
    agent: {
      agentId,
      cwd: "/workspace",
      status: "running",
      activeRunId: runId,
      name: null,
      createdAt: time,
      updatedAt: time,
      latestCheckpoint: null,
      sdkMetadata: {},
    },
  });
  await store.runs.create({
    run: {
      runId,
      requestId: null,
      agentId,
      turnNumber: 1,
      status: "running",
      model: null,
      result: null,
      error: null,
      usageRef: null,
      usage: null,
      createdAt: time,
      updatedAt: time,
      startedAt: time,
      endedAt: null,
      startCheckpointRef: null,
      latestCheckpointRef: null,
    },
  });
  const journal = new CursorTurnJournal(root, agentId);
  const turn = {
    id: "turn-1",
    createdAt: new Date(time).toISOString(),
    nativeRunId: runId,
    steers: [],
    user: { type: "user_message" as const, text: "go", messageId: "turn-1:user" },
  };
  await journal.save(turn);
  ledger = journal.processLedgerPath(turn.id);
  await mkdir(join(ledger, ".."), { recursive: true });
  await write(owner(dead));

  await assertCursorRunReleased(store, journal, agentId, "/workspace");

  // Same as owner recovery: the run row is cancelled and the turn shows the interruption.
  expect(await store.runs.get({ agentId, runId })).toMatchObject({ status: "cancelled" });
  expect(await store.agents.get({ agentId })).toMatchObject({ activeRunId: null, status: "idle" });
  expect((await journal.read())[0]).toMatchObject({
    joined: true,
    recovered: true,
    terminal: { status: "error", code: "cursor_sdk_run_interrupted" },
  });
  await expect(readFile(ledger)).rejects.toMatchObject({ code: "ENOENT" });
});

test("drops a ledger it cannot write, so recovery keeps blocking", async () => {
  const broken = new CursorProcessLedger(ledger, true);
  await broken.open();
  await rm(ledger);
  await mkdir(ledger);

  expect(() => broken.intent()).not.toThrow();
  expect(await assessProcessLedger(ledger).catch((error) => String(error))).toContain("EISDIR");
  broken.close();
});
