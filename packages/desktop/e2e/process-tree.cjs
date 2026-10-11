const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

function readProcesses() {
  return parseProcesses(
    execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
    }),
  );
}

function parseProcesses(output) {
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/,
        );
      assert.ok(match, "Cannot parse process identity");
      return { pid: Number(match[1]), parent: Number(match[2]), identity: match[3] };
    });
}

function descendants(pid, rows) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const owned = new Set([pid]);
  let previous;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  } while (previous !== owned.size);
  const result = rows.filter((row) => owned.has(row.pid));
  assert.ok(
    result.some((row) => row.pid === pid),
    "Running owner has no process identity",
  );
  return [result.find((row) => row.pid === pid), ...result.filter((row) => row.pid !== pid)];
}

function remaining(owned, rows) {
  return owned.filter((entry) =>
    rows.some((row) => row.pid === entry.pid && row.identity === entry.identity),
  );
}

function captureProcessTree(pid) {
  return descendants(pid, readProcesses());
}

function refreshProcessTree(owned, rows = readProcesses()) {
  const root = owned[0];
  if (!root || !remaining([root], rows).length) return owned;
  const additions = descendants(root.pid, rows).filter(
    (row) => !owned.some((entry) => entry.pid === row.pid && entry.identity === row.identity),
  );
  return [...owned, ...additions];
}

async function waitForProcessTreeExit(owned) {
  const deadline = Date.now() + 10000;
  while (remaining(owned, readProcesses()).length && Date.now() < deadline) await delay(100);
  assert.deepEqual(
    remaining(owned, readProcesses()),
    [],
    "Owned supervisor or worker remained alive",
  );
}

module.exports = {
  parseProcesses,
  captureProcessTree,
  refreshProcessTree,
  waitForProcessTreeExit,
  descendants,
  remaining,
};
