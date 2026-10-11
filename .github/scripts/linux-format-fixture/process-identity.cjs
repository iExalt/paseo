const assert = require("node:assert/strict");

function verifyNamespacePid(status, observerPid, namespacePid) {
  for (const pid of [observerPid, namespacePid]) assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const line = status.split("\n").find((value) => value.startsWith("NSpid:"));
  assert.match(line ?? "", /^NSpid:\s+[1-9]\d*(?:[ \t]+[1-9]\d*)*[ \t]*$/);
  const pids = line.slice("NSpid:".length).trim().split(/\s+/).map(Number);
  assert.ok(pids.every(Number.isSafeInteger));
  assert.equal(pids[0], observerPid, "First namespace PID must match the observer");
  assert.equal(pids.at(-1), namespacePid, "Last namespace PID must match renderer IPC");
  return pids;
}

module.exports = { verifyNamespacePid };
