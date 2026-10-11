import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { expect, test, vi } from "vitest";
import { signalProcessTree } from "../src/utils/tree-kill.js";
import { runSupervisor } from "./supervisor.js";

vi.mock("child_process", () => ({ fork: vi.fn(), spawn: vi.fn() }));
vi.mock("../src/utils/tree-kill.js", () => ({
  signalProcessTree: vi.fn().mockResolvedValue(undefined),
}));

test("silent workers stay alive and receive the full shutdown grace period", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    connected: true,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    send: vi.fn(),
  });
  const listeners = [
    [process, "SIGINT"],
    [process, "SIGTERM"],
    [process.stdout, "error"],
    [process.stderr, "error"],
  ] as const;
  const before = listeners.map(([emitter, event]) => emitter.listeners(event));
  vi.useFakeTimers();
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const ready = vi.fn();
  const stopped = vi.fn();
  try {
    const controller = runSupervisor({
      name: "TimingTest",
      startupMessage: "starting",
      resolveWorkerEntry: () => "fixture.mjs",
      restartOnCrash: true,
      onWorkerReady: ready,
      onSupervisorExit: stopped,
    });
    child.emit("message", { type: "paseo:ready", listen: "fixture", serverId: "test" });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(ready).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledOnce();
    expect(signalProcessTree).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(child.send.mock.calls).toHaveLength(16);
    expect(
      child.send.mock.calls.every(([message]) => message.type === "paseo:supervisor-heartbeat"),
    ).toBe(true);

    controller.requestShutdown("test_complete");
    expect(child.send).toHaveBeenLastCalledWith(
      { type: "paseo:graceful-shutdown", reason: "test_complete" },
      expect.any(Function),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signalProcessTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signalProcessTree).toHaveBeenCalledExactlyOnceWith(child, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(stopped).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    listeners.forEach(([emitter, event], index) => {
      for (const listener of emitter.listeners(event)) {
        if (!before[index].includes(listener)) emitter.removeListener(event, listener);
      }
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
