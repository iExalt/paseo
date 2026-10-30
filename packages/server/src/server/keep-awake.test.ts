import { EventEmitter } from "node:events";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createKeepAwakeController, type KeepAwakeChild } from "./keep-awake.js";

function createMockLogger() {
  const messages: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[] = [];
  const logger = {
    messages,
    child: () => logger,
    debug: (...args: unknown[]) => messages.push({ level: "debug", args }),
    info: (...args: unknown[]) => messages.push({ level: "info", args }),
    warn: (...args: unknown[]) => messages.push({ level: "warn", args }),
    error: (...args: unknown[]) => messages.push({ level: "error", args }),
  };
  return logger;
}

type TestLogger = ReturnType<typeof createMockLogger>;

function logEvents(logger: TestLogger): string[] {
  return logger.messages.map((entry) => `${entry.level}:${String(entry.args[1])}`);
}

let nextPid = 1000;

// Mirrors node's ChildProcess events: "spawn" on success, "error" then "close" on
// spawn failure, "close" after the process exits.
class FakeChild extends EventEmitter implements KeepAwakeChild {
  readonly pid = nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  exitOnSignal = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function createHarness(options: { platform?: NodeJS.Platform; failSpawn?: boolean } = {}) {
  const logger = createMockLogger();
  const children: FakeChild[] = [];
  const controller = createKeepAwakeController({
    logger: logger as unknown as pino.Logger,
    platform: options.platform ?? "darwin",
    spawnAssertion: () => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => {
        if (options.failSpawn) {
          const error = Object.assign(new Error("spawn /usr/bin/caffeinate ENOENT"), {
            code: "ENOENT",
          });
          child.emit("error", error);
          child.exit(-2, null);
          return;
        }
        child.emit("spawn");
      });
      return child;
    },
    maxRespawns: 2,
    respawnBackoffMs: 1_000,
    stableAfterMs: 60_000,
    killTimeoutMs: 2_000,
    now: () => Date.now(),
  });
  return { controller, logger, children };
}

describe("keep-awake controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("holds one assertion until released, logging both transitions", async () => {
    const { controller, logger, children } = createHarness();

    controller.hold();
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);

    controller.release("relay_disabled");
    controller.release("setting_disabled");
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(logEvents(logger)).toEqual([
      "info:power_assertion_acquired",
      "info:power_assertion_released",
    ]);
    expect(logger.messages[1].args[0]).toEqual({ pid: children[0].pid, reason: "relay_disabled" });
  });

  test("never spawns off macOS", async () => {
    const { controller, logger, children } = createHarness({ platform: "linux" });

    controller.hold();
    await controller.stop();

    expect(children).toHaveLength(0);
    expect(logger.messages).toHaveLength(0);
  });

  test("respawns a lost assertion, then gives up after the respawn budget", async () => {
    const { controller, logger, children } = createHarness();
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);

    children[0].exit(1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    children[1].exit(1, null);
    await vi.advanceTimersByTimeAsync(2_000);
    children[2].exit(1, null);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toHaveLength(3);
    expect(logEvents(logger).filter((event) => event.startsWith("warn"))).toEqual([
      "warn:power_assertion_lost",
      "warn:power_assertion_lost",
      "warn:power_assertion_lost",
      "warn:power_assertion_failed",
    ]);

    // A fresh hold after a release starts with a full budget.
    controller.release("setting_disabled");
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(4);
  });

  test("a long-lived assertion resets the respawn budget", async () => {
    const { controller, children } = createHarness();
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);

    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      children[children.length - 1].exit(1, null);
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(children).toHaveLength(5);
  });

  test("a missing caffeinate binary fails once without a lost event or respawn", async () => {
    const { controller, logger, children } = createHarness({ failSpawn: true });

    controller.hold();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(children).toHaveLength(1);
    expect(logEvents(logger)).toEqual(["warn:power_assertion_failed"]);
  });

  test("releasing during a pending respawn cancels it", async () => {
    const { controller, children } = createHarness();
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);

    children[0].exit(1, null);
    controller.release("relay_disabled");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toHaveLength(1);
  });

  test("stop waits for the assertion to exit and escalates to SIGKILL", async () => {
    const { controller, logger, children } = createHarness();
    controller.hold();
    await vi.advanceTimersByTimeAsync(0);
    children[0].exitOnSignal = false;

    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
      return stopped;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(logEvents(logger)).not.toContain("warn:power_assertion_lost");
    expect(logger.messages.at(-1)?.args[0]).toEqual({ pid: children[0].pid, reason: "shutdown" });
  });
});
