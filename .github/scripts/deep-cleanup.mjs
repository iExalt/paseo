import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

export function ownedProcesses(owner) {
  assert.match(owner, /^[a-f0-9-]{36}$/);
  const marker = `CI_DEEP_OWNER=${owner}`;
  const pids = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Runner-owned processes are inspectable; unrelated system UIDs are not
      // evidence about the command tree and often deny environment access.
      if (statSync(`/proc/${entry}`).uid !== process.getuid()) continue;
      if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker)) {
        pids.push(Number(entry));
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return pids;
}

export function verifyDeepCleanup(owner, graceMs = 5_000) {
  if (process.platform !== "linux") return;
  const deadline = performance.now() + graceMs;
  let pids;
  do {
    pids = ownedProcesses(owner);
    if (pids.length === 0) {
      console.log("[deep] No surviving processes retain the command ownership marker");
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  } while (performance.now() < deadline);
  assert.deepEqual(pids, [], "Deep command leaked marked processes");
}
