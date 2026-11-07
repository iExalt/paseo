import { describe, expect, it, vi } from "vitest";
import {
  prepareWindowsAppUpdate,
  type WindowsUpdateDaemonStatus,
} from "./windows-update-safety.js";
const running: WindowsUpdateDaemonStatus = {
  status: "running",
  pid: 12,
  startedAt: "one",
  ownedByDesktop: true,
};
const stopped: WindowsUpdateDaemonStatus = {
  status: "stopped",
  pid: null,
  startedAt: null,
  ownedByDesktop: false,
};
describe("Windows apply safety", () => {
  it("admits only owned idle shutdown, confirms exit and workers before installer", async () => {
    const events: string[] = [];
    const readStatus = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(stopped);
    await prepareWindowsAppUpdate({
      readStatus,
      assertNoWorkers: async (allow) => {
        events.push(allow ? "terminals" : "workers");
      },
      stopOwnedIfIdle: async () => {
        events.push("idle-stop");
        return "stopped";
      },
      restoreDaemon: vi.fn(),
    });
    expect(events).toEqual(["terminals", "idle-stop", "workers"]);
  });
  it.each(["declined", "unsupported"] as const)(
    "refuses %s shutdown without touching work",
    async (outcome) => {
      const restoreDaemon = vi.fn();
      await expect(
        prepareWindowsAppUpdate({
          readStatus: async () => running,
          assertNoWorkers: async () => {},
          stopOwnedIfIdle: async () => outcome,
          restoreDaemon,
        }),
      ).rejects.toThrow();
      expect(restoreDaemon).not.toHaveBeenCalled();
    },
  );
  it("blocks an external daemon before any stop", async () => {
    const stop = vi.fn();
    await expect(
      prepareWindowsAppUpdate({
        readStatus: async () => ({ ...running, ownedByDesktop: false }),
        assertNoWorkers: async () => {},
        stopOwnedIfIdle: stop,
        restoreDaemon: vi.fn(),
      }),
    ).rejects.toThrow("outside");
    expect(stop).not.toHaveBeenCalled();
  });
  it("preserves a raced terminal and restores the old daemon for retry", async () => {
    const restoreDaemon = vi.fn();
    await expect(
      prepareWindowsAppUpdate({
        readStatus: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(stopped),
        assertNoWorkers: async (allow) => {
          if (!allow) throw new Error("raced terminal");
        },
        stopOwnedIfIdle: async () => "stopped",
        restoreDaemon,
      }),
    ).rejects.toThrow("raced terminal");
    expect(restoreDaemon).toHaveBeenCalledOnce();
  });
  it("recovers a lost shutdown response only when the daemon is confirmed stopped", async () => {
    const restoreDaemon = vi.fn();
    await expect(
      prepareWindowsAppUpdate({
        readStatus: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(stopped),
        assertNoWorkers: async () => {},
        stopOwnedIfIdle: async () => {
          throw new Error("lost response");
        },
        restoreDaemon,
      }),
    ).rejects.toThrow("lost response");
    expect(restoreDaemon).toHaveBeenCalledOnce();
  });
});

import { createWindowsUpdateAdmission } from "./windows-update-admission.js";
it("drains prior starts and rejects start/restart during a worker wait", async () => {
  const admission = createWindowsUpdateAdmission();
  let finishStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const priorStart = admission.run(() => startGate);
  const acquire = admission.acquire();
  await expect(admission.run(async () => {})).rejects.toThrow("paused");
  finishStart();
  await priorStart;
  const release = await acquire;
  let checks = 0;
  await expect(
    prepareWindowsAppUpdate({
      readStatus: async () => (++checks < 3 ? stopped : running),
      assertNoWorkers: async (allow) => {
        if (!allow) await expect(admission.run(async () => {})).rejects.toThrow("paused");
      },
      stopOwnedIfIdle: async () => "stopped",
      restoreDaemon: async () => {},
    }),
  ).rejects.toThrow("started during");
  release();
  await expect(admission.run(async () => "retry")).resolves.toBe("retry");
});
