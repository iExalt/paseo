/** One app-owned boundary for async daemon starts and a Windows installer handoff. */
export function createWindowsUpdateAdmission() {
  let applying = false;
  const pending = new Set<Promise<unknown>>();
  return {
    assertOpen(): void {
      if (applying)
        throw new Error("Fork update is applying. Daemon starts are paused until it finishes.");
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      this.assertOpen();
      const result = operation();
      pending.add(result);
      try {
        return await result;
      } finally {
        pending.delete(result);
      }
    },
    async acquire(): Promise<() => void> {
      this.assertOpen();
      applying = true;
      await Promise.allSettled(pending);
      return () => {
        applying = false;
      };
    },
  };
}
