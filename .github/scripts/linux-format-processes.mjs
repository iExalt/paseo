import assert from "node:assert/strict";

export function verifyCompleteMonitor(started, completed) {
  assert.equal(completed.owner, started.owner);
  assert.equal(
    completed.complete,
    true,
    "Incomplete monitor discovery cannot authorize state removal",
  );
  assert.deepEqual(completed.remaining, []);
  assert.deepEqual(completed.mounts, []);
}

export function ownedProcesses(rows, session, retained, owner) {
  const selected = new Set(
    rows
      .filter(
        (row) =>
          row.session === session ||
          (owner !== undefined && row.owner === owner) ||
          retained.some((owned) => owned.pid === row.pid && owned.start === row.start),
      )
      .map((row) => row.pid),
  );
  let previous;
  do {
    previous = selected.size;
    for (const row of rows) if (selected.has(row.parent)) selected.add(row.pid);
  } while (previous !== selected.size);
  return rows.filter((row) => selected.has(row.pid));
}

export function unreadableUnknowns(rows, members) {
  return rows.filter(
    (row) =>
      row.unreadable &&
      !members.some((member) => member.pid === row.pid && member.start === row.start),
  );
}
