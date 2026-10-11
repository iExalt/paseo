import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { elevatedOwnedProcesses } from "./deep-cleanup.mjs";
import { removeOwnedTree } from "../../packages/desktop/e2e/remove-owned-tree.mjs";
import { verifyCompleteMonitor } from "./linux-format-processes.mjs";
import { stageTemporaryDirectory, validateTemporaryRoot } from "./linux-product-temp.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const root = `${process.env.RUNNER_TEMP}/paseo-products-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
assert.equal(realpathSync(root), root);
assert.equal(readFileSync(join(root, "owned"), "utf8").trim(), process.env.GITHUB_SHA);
const evidence = join(root, "evidence");
const temporaryReceipt = join(root, "temporary-root.json");
const temporary = existsSync(temporaryReceipt)
  ? JSON.parse(readFileSync(temporaryReceipt))
  : undefined;
let temporaryRemoved = false;
if (temporary) {
  if (existsSync(temporary.path)) validateTemporaryRoot(temporary);
  else {
    // The workflow repeats cleanup after the runtime's EXIT trap.
    const completed = JSON.parse(readFileSync(join(evidence, "state-cleanup.json")));
    assert.equal(completed.complete, true);
    assert.deepEqual(completed.removedTemporaryRoot, temporary);
    temporaryRemoved = true;
  }
}

function identity(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    return { pid, start: fields[19] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return undefined;
    throw error;
  }
}
function signalOwned(entry, signal) {
  if (identity(entry.pid)?.start !== entry.start) return;
  try {
    process.kill(entry.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function members(receipt) {
  const before = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((name) => identity(Number(name)))
    .filter(Boolean);
  const pids = elevatedOwnedProcesses(receipt.owner, { uid: receipt.originalUid });
  return before.filter(
    (entry) => pids.includes(entry.pid) && identity(entry.pid)?.start === entry.start,
  );
}
function mounts() {
  return readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => ({ target: line.split(" ")[4], type: line.split(" - ")[1].split(" ")[0] }))
    .filter(
      (mount) =>
        mount.target.startsWith(`${root}/`) ||
        (temporary &&
          (mount.target === temporary.path || mount.target.startsWith(`${temporary.path}/`))),
    );
}
const starts = readdirSync(evidence).filter((name) =>
  /^(appimage|deb)-(previous|candidate)-started\.json$/.test(name),
);
for (const name of starts) {
  const receipt = JSON.parse(readFileSync(join(evidence, name)));
  assert.equal(receipt.originalUid, process.getuid());
  assert.ok(temporary);
  assert.equal(
    receipt.tmpdir,
    stageTemporaryDirectory(temporary, name.replace("-started.json", "")),
  );
  assert.ok(Number.isSafeInteger(receipt.monitor.pid) && receipt.monitor.pid > 0);
  assert.match(receipt.monitor.start, /^\d+$/);
  // A timeout may have killed the monitor before its own finally block ran.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    signalOwned(receipt.monitor, signal);
    for (const entry of members(receipt)) signalOwned(entry, signal);
    await delay(250);
  }
  assert.notEqual(identity(receipt.monitor.pid)?.start, receipt.monitor.start);
  assert.deepEqual(elevatedOwnedProcesses(receipt.owner, { uid: receipt.originalUid }), []);
}
for (const mount of mounts()) {
  assert.match(mount.type, /^fuse/);
  execFileSync("fusermount3", ["-u", mount.target], { timeout: 5000 });
}
assert.deepEqual(mounts(), []);
for (const name of starts) {
  const started = JSON.parse(readFileSync(join(evidence, name)));
  const completed = JSON.parse(
    readFileSync(join(evidence, name.replace("-started.json", "-cleanup.json"))),
  );
  verifyCompleteMonitor(started, completed);
}
if (temporary && !temporaryRemoved) {
  validateTemporaryRoot(temporary);
  await removeOwnedTree(temporary.path);
}
for (const name of ["state", "portable"]) {
  const directory = join(root, name);
  if (existsSync(directory)) await removeOwnedTree(directory);
}
// The container is already absent; its state can have a different numeric UID.
const rpmState = join(root, "rpm-state");
if (existsSync(rpmState)) {
  execFileSync(
    "sudo",
    [
      "-n",
      "--",
      process.execPath,
      "--input-type=module",
      "-e",
      "const {removeOwnedTree}=await import(process.argv[1]); await removeOwnedTree(process.argv[2]);",
      new URL("../../packages/desktop/e2e/remove-owned-tree.mjs", import.meta.url).href,
      rpmState,
    ],
    { timeout: 10000 },
  );
}
writeFileSync(
  join(evidence, "state-cleanup.json"),
  JSON.stringify({
    complete: true,
    nativeSessions: starts.length,
    mounts: mounts(),
    removed: ["state", "portable", "rpm-state"],
    removedTemporaryRoot: temporary,
  }),
);
