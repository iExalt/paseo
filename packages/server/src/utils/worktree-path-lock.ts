import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Archive decides a worktree directory is unreferenced and then deletes it; creating a workspace
// on that directory between the two left an active workspace on a deleted path. Both run their
// critical section under this lock. Paths overlap when one contains the other, so a workspace
// created on a subdirectory waits for the archive of its worktree.

const held = new Map<string, Promise<void>>();
const waiting = new Map<string, number>();

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

export async function withWorktreePathLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  // Callers spell one directory differently (macOS /tmp vs /private/tmp), so key on its real path.
  const key = await realpath(path).catch(() => resolve(path));
  for (;;) {
    const blockers = [...held].filter(([heldPath]) => overlaps(heldPath, key));
    if (blockers.length === 0) break;
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    try {
      await Promise.all(blockers.map(([, done]) => done));
    } finally {
      const count = (waiting.get(key) ?? 1) - 1;
      if (count === 0) waiting.delete(key);
      else waiting.set(key, count);
    }
  }
  let release!: () => void;
  held.set(
    key,
    new Promise<void>((resolveDone) => {
      release = resolveDone;
    }),
  );
  try {
    return await work();
  } finally {
    held.delete(key);
    release();
  }
}

/** How many callers are blocked waiting to lock exactly this path. */
export async function countWorktreePathLockWaiters(path: string): Promise<number> {
  return waiting.get(await realpath(path).catch(() => resolve(path))) ?? 0;
}
