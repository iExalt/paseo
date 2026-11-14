export interface WindowsUpdateDaemonStatus {
  status: "starting" | "running" | "stopped" | "errored";
  pid: number | null;
  startedAt: string | null;
  ownedByDesktop: boolean;
}
/** Rechecks after idle shutdown: a raced terminal stays alive and blocks replacement. */
export async function prepareWindowsAppUpdate(input: {
  readStatus(): Promise<WindowsUpdateDaemonStatus>;
  assertNoWorkers(allowEmptyWorkers: boolean): Promise<void>;
  stopOwnedIfIdle(): Promise<"stopped" | "declined" | "unsupported">;
  restoreDaemon(): Promise<unknown>;
}): Promise<void> {
  await input.assertNoWorkers(true);
  const before = await input.readStatus();
  if (before.status === "errored" || before.status === "starting")
    throw new Error("Waiting for daemon status before applying the fork update.");
  if (before.status === "running" && !before.ownedByDesktop)
    throw new Error("Fork update is waiting for a daemon started outside this app to exit.");
  let stopped = false;
  try {
    if (before.status === "running") {
      const result = await input.stopOwnedIfIdle();
      if (result !== "stopped")
        throw new Error(
          result === "declined"
            ? "Fork update is waiting for active agents to finish."
            : "This daemon cannot stop safely for an update. Update the host manually first.",
        );
      stopped = true;
    }
    const after = await input.readStatus();
    if (after.status !== "stopped")
      throw new Error("Fork update is waiting for the daemon to exit. Try again.");
    await input.assertNoWorkers(false);
    if ((await input.readStatus()).status !== "stopped")
      throw new Error("A daemon started during update preparation. Update refused.");
  } catch (error) {
    if (stopped || (before.status === "running" && (await input.readStatus()).status === "stopped"))
      await input.restoreDaemon();
    throw error;
  }
}
