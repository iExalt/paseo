import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import {
  ownedProcesses,
  unreadableUnknowns,
  reconcilePrivilegedScan,
} from "./linux-format-processes.mjs";
import { elevatedOwnedProcesses } from "./deep-cleanup.mjs";

// A detached session scopes Xvfb, the FUSE runtime and Chromium even if parents exit.
// PID plus kernel start time prevents signaling a subsequently reused PID.
const owner = randomUUID();
const originalUid = Number(process.env.OWNED_SESSION_UID ?? process.getuid());
assert.ok(Number.isSafeInteger(originalUid) && originalUid > 0);
function processes(readEnvironment = true) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const fields = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1).split(" ");
        const row = {
          pid: Number(name),
          parent: Number(fields[1]),
          group: Number(fields[2]),
          session: Number(fields[3]),
          start: fields[19],
        };
        if (readEnvironment && statSync(`/proc/${name}`).uid === originalUid) {
          try {
            if (
              readFileSync(`/proc/${name}/environ`, "utf8")
                .split("\0")
                .includes(`CI_DEEP_OWNER=${owner}`)
            )
              row.owner = owner;
          } catch (error) {
            if (!["EACCES", "EPERM"].includes(error.code)) throw error;
            row.unreadable = true;
          }
          const current = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1).split(" ");
          if (current[19] !== row.start) return [];
        }
        return [row];
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code)) return [];
        throw error;
      }
    });
}
function mounts() {
  return readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => ({ target: line.split(" ")[4], type: line.split(" - ")[1].split(" ")[0] }))
    .filter(({ target }) => target.startsWith(`${process.env.TMPDIR}/`));
}
assert.equal(process.platform, "linux");
assert.ok(!process.argv.slice(2).includes("--no-sandbox"), "Harness must not disable sandboxing");
assert.ok(!process.env.PASEO_ELECTRON_FLAGS, "Harness must not inject Electron flags");
assert.ok(process.env.TMPDIR?.startsWith("/") && process.env.TMPDIR.length > 10);
mkdirSync(process.env.TMPDIR, { recursive: true });
assert.deepEqual(mounts(), [], "Owned temporary directory must begin without mounts");
const timeoutSeconds = Number(process.env.OWNED_SESSION_TIMEOUT_SECONDS ?? 60);
assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 180);
const command =
  process.env.OWNED_SESSION_SKIP_XVFB === "1"
    ? process.argv.slice(2)
    : ["xvfb-run", "-a", ...process.argv.slice(2)];
const receiptDirectory =
  process.env.OWNED_SESSION_RECEIPT_DIRECTORY ?? join(process.env.TMPDIR, "..");
assert.ok(receiptDirectory.startsWith("/"));
const receipt = (suffix) => join(receiptDirectory, `${process.env.FIXTURE_FORMAT}-${suffix}.json`);
assert.match(process.env.FIXTURE_FORMAT, /^[a-z]+(?:-[a-z]+)?$/);
writeFileSync(
  receipt("started"),
  JSON.stringify({
    owner,
    originalUid,
    tmpdir: process.env.TMPDIR,
    monitor: processes(false).find((row) => row.pid === process.pid),
  }),
);
const child = spawn(command[0], command.slice(1), {
  detached: true,
  stdio: "inherit",
  env: { ...process.env, CI_DEEP_OWNER: owner },
});
let result;
child.once("error", (error) => {
  result = { error: error.message };
});
child.once("exit", (code, signal) => {
  result = { code, signal };
});
const owned = new Map();
let interrupted;
let discoveryFailure;
let discoveryPending = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = signal;
  });
function capture() {
  let rows = processes();
  let members = ownedProcesses(rows, child.pid, [...owned.values()], owner);
  let unknown = unreadableUnknowns(rows, members);
  discoveryFailure = undefined;
  discoveryPending = false;
  if (unknown.length && process.getuid() !== 0) {
    try {
      const marked = elevatedOwnedProcesses(owner, { uid: originalUid });
      const after = processes(false);
      ({ rows, pending: discoveryPending } = reconcilePrivilegedScan(rows, after, marked, owner));
      members = ownedProcesses(rows, child.pid, [...owned.values()], owner);
      unknown = unreadableUnknowns(rows, members);
    } catch (error) {
      discoveryFailure = error;
    }
  }
  if (unknown.length)
    discoveryFailure ??= new Error(
      `Unreadable unclassified processes: ${unknown.map((row) => row.pid).join(",")}`,
    );
  // A reused leader PID would identify another session, never ours.
  const leader = rows.find(({ pid }) => pid === child.pid);
  const original = owned.get(child.pid);
  if (leader && original) assert.equal(leader.start, original.start, "Fixture leader PID reused");
  if (leader && !original) owned.set(child.pid, leader);
  for (const entry of members) {
    if (!owned.has(entry.pid)) owned.set(entry.pid, entry);
    else assert.equal(entry.start, owned.get(entry.pid).start, "Fixture member PID reused");
  }
  return members;
}
let failure;
const finished = () => Boolean(result || interrupted);
try {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!finished() && Date.now() < deadline) {
    capture();
    if (discoveryFailure) throw discoveryFailure;
    await delay(50);
  }
  assert.ok(result, interrupted ?? `Owned launch exceeded ${timeoutSeconds}s`);
  assert.deepEqual(result, { code: 0, signal: null }, "Fixture must exit normally");
  const deadlineExit = Date.now() + 10000;
  while ((capture().length || discoveryPending || mounts().length) && Date.now() < deadlineExit)
    await delay(100);
  assert.deepEqual(capture(), [], "Fixture session still running after normal exit");
  assert.equal(discoveryPending, false, "New discovery requires another identity capture");
  if (discoveryFailure) throw discoveryFailure;
  assert.deepEqual(mounts(), [], "Fixture FUSE mount remains after normal exit");
} catch (error) {
  failure = error;
}
function signalOwned(entry, signal) {
  const current = processes(false).find(({ pid }) => pid === entry.pid);
  if (current?.start !== entry.start) return;
  try {
    process.kill(entry.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function cleanupOwned() {
  if (failure) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      for (const entry of capture()) {
        signalOwned(entry, signal);
      }
      await delay(500);
    }
    for (const mount of mounts()) {
      assert.match(mount.type, /^fuse/, "Refusing to unmount a non-FUSE filesystem");
      execFileSync("fusermount3", ["-u", mount.target], { timeout: 5000 });
    }
  }
  const cleanup = {
    result,
    failure: failure?.message,
    remaining: capture(),
    mounts: mounts(),
    owned: [...owned.values()],
    owner,
    session: child.pid,
    discoveryFailure: discoveryFailure?.message,
    discoveryPending,
  };
  cleanup.complete =
    cleanup.remaining.length === 0 &&
    cleanup.mounts.length === 0 &&
    !discoveryFailure &&
    !discoveryPending;
  writeFileSync(receipt("cleanup"), JSON.stringify(cleanup, null, 2));
  assert.deepEqual(cleanup.remaining, [], "Owned fixture processes remained");
  assert.deepEqual(cleanup.mounts, [], "Owned fixture mounts remained");
  assert.equal(cleanup.complete, true, "Process discovery must be complete");
}
try {
  await cleanupOwned();
} catch (cleanupError) {
  throw new AggregateError([failure, cleanupError].filter(Boolean), "Fixture cleanup failed", {
    cause: cleanupError,
  });
}
if (failure) throw failure;
