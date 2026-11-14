// Creation, restore and archive must agree on whether a workspace admits chats.
const tails = new Map<string, Promise<void>>();

export async function withWorkspaceLifecycleLock<T>(
  workspaceIds: Iterable<string>,
  work: () => Promise<T>,
): Promise<T> {
  const ids = [...new Set(workspaceIds)].sort();
  async function lock(index: number): Promise<T> {
    const id = ids[index];
    if (id === undefined) return work();
    const previous = tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const reservation = new Promise<void>((done) => {
      release = done;
    });
    const tail = previous.then(() => reservation);
    tails.set(id, tail);
    await previous;
    try {
      return await lock(index + 1);
    } finally {
      release();
      if (tails.get(id) === tail) tails.delete(id);
    }
  }
  return lock(0);
}
