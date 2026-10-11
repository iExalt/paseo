import assert from "node:assert/strict";
import test from "node:test";
import processTree from "../packages/desktop/e2e/process-tree.cjs";

test("process identity contains only stable start time and strictly rejects command text", () => {
  const rows = processTree.parseProcesses(" 100 1 Sat Oct 10 20:30:00 2026\n");
  assert.deepEqual(rows, [{ pid: 100, parent: 1, identity: "Sat Oct 10 20:30:00 2026" }]);
  assert.deepEqual(
    processTree.remaining(
      rows,
      rows.map((row) => ({ ...row, title: "Paseo Daemon" })),
    ),
    rows,
  );
  assert.throws(() => processTree.parseProcesses("100 1 Sat Oct 10 20:30:00 2026 mutable title"));
  assert.throws(() => processTree.parseProcesses("100 1 malformed start"));
});

test("cleanup retains descendant identity after reparenting but excludes reused PIDs", () => {
  const supervisor = { pid: 100, parent: 1, identity: "start-A supervisor" };
  const worker = { pid: 101, parent: 100, identity: "start-B worker" };
  const child = { pid: 102, parent: 101, identity: "start-C child" };
  const unrelated = { pid: 103, parent: 1, identity: "start-D unrelated" };
  const owned = processTree.descendants(100, [child, supervisor, unrelated, worker]);
  assert.deepEqual(new Set(owned.map(({ pid }) => pid)), new Set([100, 101, 102]));
  assert.deepEqual(processTree.remaining(owned, [{ ...worker, parent: 1 }, unrelated]), [worker]);
  assert.deepEqual(processTree.remaining(owned, [{ ...worker, identity: "new-start worker" }]), []);
  const later = { pid: 104, parent: 100, identity: "start-E plugin" };
  assert.deepEqual(processTree.refreshProcessTree(owned, [supervisor, later]), [...owned, later]);
  assert.deepEqual(
    processTree.refreshProcessTree(owned, [{ ...supervisor, identity: "reused PID" }, later]),
    owned,
  );
});
