import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { ownedProcesses } from "./linux-format-processes.mjs";

// A detached session scopes Xvfb, the FUSE runtime and Chromium even if parents exit.
// PID plus kernel start time prevents signaling a subsequently reused PID.
function processes() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const fields = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1).split(" ");
        return [
          {
            pid: Number(name),
            group: Number(fields[2]),
            session: Number(fields[3]),
            start: fields[19],
          },
        ];
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
const child = spawn("xvfb-run", ["-a", ...process.argv.slice(2)], {
  detached: true,
  stdio: "inherit",
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
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = signal;
  });
function capture() {
  const rows = processes();
  const members = ownedProcesses(rows, child.pid, [...owned.values()]);
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
  const deadline = Date.now() + 60000;
  while (!finished() && Date.now() < deadline) {
    capture();
    await delay(50);
  }
  assert.ok(result, interrupted ?? "Fixture launch exceeded 60s");
  assert.deepEqual(result, { code: 0, signal: null }, "Fixture must exit normally");
  const deadlineExit = Date.now() + 10000;
  while ((capture().length || mounts().length) && Date.now() < deadlineExit) await delay(100);
  assert.deepEqual(capture(), [], "Fixture session still running after normal exit");
  assert.deepEqual(mounts(), [], "Fixture FUSE mount remains after normal exit");
} catch (error) {
  failure = error;
}
function signalOwned(entry, signal) {
  const current = processes().find(({ pid }) => pid === entry.pid);
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
  };
  writeFileSync(
    join(process.env.TMPDIR, "..", `${process.env.FIXTURE_FORMAT}-cleanup.json`),
    JSON.stringify(cleanup, null, 2),
  );
  assert.deepEqual(cleanup.remaining, [], "Owned fixture processes remained");
  assert.deepEqual(cleanup.mounts, [], "Owned fixture mounts remained");
}
try {
  await cleanupOwned();
} catch (cleanupError) {
  throw new AggregateError([failure, cleanupError].filter(Boolean), "Fixture cleanup failed", {
    cause: cleanupError,
  });
}
if (failure) throw failure;
