import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(import.meta.url);
function validateOwner(owner) {
  assert.match(owner, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
}

function validateHosted(env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Elevated scan is GitHub-hosted only");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Elevated scan is GitHub-hosted only");
}

function scanProcesses(owner, uid) {
  validateOwner(owner);
  assert.ok(Number.isSafeInteger(uid) && uid >= 0, "Invalid original UID");
  const marker = `CI_DEEP_OWNER=${owner}`;
  const pids = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Runner-owned processes are the scan scope; unrelated system UIDs are
      // not evidence about the command tree.
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker)) {
        pids.push(Number(entry));
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return pids;
}

export function elevatedOwnedProcesses(
  owner,
  { env = process.env, uid = process.getuid?.(), run = execFileSync } = {},
) {
  validateHosted(env);
  validateOwner(owner);
  assert.ok(Number.isSafeInteger(uid) && uid >= 0, "Invalid original UID");
  const output = run(
    "sudo",
    [
      "-n",
      "--preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT",
      "--",
      process.execPath,
      helper,
      "--scan",
      String(uid),
      owner,
    ],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, env },
  );
  const pids = JSON.parse(output);
  assert.ok(
    Array.isArray(pids) && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
    "Invalid scan result",
  );
  assert.equal(new Set(pids).size, pids.length, "Duplicate scan result");
  return pids;
}

export function ownedProcesses(owner) {
  try {
    return scanProcesses(owner, process.getuid());
  } catch (error) {
    if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    return elevatedOwnedProcesses(owner);
  }
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

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  validateHosted(process.env);
  assert.equal(process.getuid(), 0, "Scanner must run as root");
  assert.equal(process.argv.length, 5);
  assert.equal(process.argv[2], "--scan");
  assert.match(process.argv[3], /^(0|[1-9]\d*)$/);
  console.log(JSON.stringify(scanProcesses(process.argv[4], Number(process.argv[3]))));
}
