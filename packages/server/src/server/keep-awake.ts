import { spawn } from "node:child_process";
import type pino from "pino";

// Holds a macOS PreventSystemSleep assertion through `caffeinate -s -w <daemon pid>`.
// The daemon runs as plain Node (ELECTRON_RUN_AS_NODE), so Electron's powerSaveBlocker
// is unavailable. `-w` makes caffeinate exit when the daemon does, so a crash or
// SIGKILL can't leave the Mac pinned awake. `-s` only takes effect on AC power.

export type KeepAwakeReleaseReason = "relay_disabled" | "setting_disabled" | "shutdown";

export interface KeepAwakeChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type SpawnKeepAwakeAssertion = () => KeepAwakeChild;

export interface KeepAwakeController {
  hold(): void;
  release(reason: KeepAwakeReleaseReason): void;
  stop(): Promise<void>;
}

interface KeepAwakeControllerOptions {
  logger: pino.Logger;
  platform?: NodeJS.Platform;
  // Defaults to caffeinate; null disables the controller.
  spawnAssertion?: SpawnKeepAwakeAssertion | null;
  maxRespawns?: number;
  respawnBackoffMs?: number;
  // A child that lived this long resets the respawn budget.
  stableAfterMs?: number;
  killTimeoutMs?: number;
  now?: () => number;
}

export function spawnCaffeinate(): KeepAwakeChild {
  return spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
}

export function createKeepAwakeController(
  options: KeepAwakeControllerOptions,
): KeepAwakeController {
  const logger = options.logger.child({ module: "keep-awake" });
  const spawnAssertion =
    options.spawnAssertion === undefined ? spawnCaffeinate : options.spawnAssertion;
  const supported = (options.platform ?? process.platform) === "darwin" && spawnAssertion !== null;
  const maxRespawns = options.maxRespawns ?? 3;
  const respawnBackoffMs = options.respawnBackoffMs ?? 5_000;
  const stableAfterMs = options.stableAfterMs ?? 60_000;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  const now = options.now ?? Date.now;

  let wanted = false;
  let stopped = false;
  let child: KeepAwakeChild | null = null;
  let losses = 0;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;
  const terminations = new Set<Promise<void>>();

  function acquire(): void {
    if (!spawnAssertion) return;
    let current: KeepAwakeChild;
    try {
      current = spawnAssertion();
    } catch (error) {
      logger.warn({ err: error }, "power_assertion_failed");
      return;
    }
    child = current;
    const startedAt = now();
    let spawnError: Error | null = null;
    current.once("spawn", () => {
      if (child === current) logger.info({ pid: current.pid }, "power_assertion_acquired");
    });
    // `on`, not `once`: kill() can emit "error" later, and an unhandled one would crash the daemon.
    current.on("error", (error) => {
      spawnError ??= error;
    });
    current.once("close", (code, signal) => {
      // A child we released (or replaced) is no longer `child`; its exit is expected.
      if (child !== current) return;
      child = null;
      if (spawnError) {
        logger.warn({ err: spawnError }, "power_assertion_failed");
        return;
      }
      logger.warn({ pid: current.pid, code, signal }, "power_assertion_lost");
      if (wanted) scheduleRespawn(now() - startedAt);
    });
  }

  function scheduleRespawn(livedMs: number): void {
    if (livedMs >= stableAfterMs) losses = 0;
    losses += 1;
    if (losses > maxRespawns) {
      logger.warn({ respawns: maxRespawns }, "power_assertion_failed");
      return;
    }
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (wanted && !child) acquire();
    }, respawnBackoffMs * losses);
    respawnTimer.unref?.();
  }

  function terminate(current: KeepAwakeChild): Promise<void> {
    if (current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
    const termination = new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        current.kill("SIGKILL");
        resolve();
      }, killTimeoutMs);
      killTimer.unref?.();
      current.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });
      current.kill("SIGTERM");
    });
    terminations.add(termination);
    void termination.finally(() => terminations.delete(termination));
    return termination;
  }

  function release(reason: KeepAwakeReleaseReason): void {
    wanted = false;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    const current = child;
    child = null;
    if (!current) return;
    logger.info({ pid: current.pid, reason }, "power_assertion_released");
    void terminate(current);
  }

  return {
    hold() {
      if (!supported || stopped || wanted) return;
      wanted = true;
      losses = 0;
      acquire();
    },
    release(reason) {
      if (!supported) return;
      release(reason);
    },
    async stop() {
      stopped = true;
      if (supported) release("shutdown");
      await Promise.all(terminations);
    },
  };
}
