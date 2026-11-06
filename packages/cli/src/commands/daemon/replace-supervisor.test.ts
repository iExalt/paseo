import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { createSupervisorReplacement } from "./replace-supervisor.js";

function fixture() {
  const previous = {
    pid: 100,
    startedAt: "2026-11-06T00:00:00Z",
    desktopManaged: true,
    serverId: "same-host",
  };
  const next = {
    ...previous,
    pid: 200,
    startedAt: "2026-11-06T01:00:00Z",
    listen: "127.0.0.1:7777",
  };
  const connections = [1000, 2000].map((pid) => ({
    getLastServerInfoMessage: () => ({
      version: "1.0.0",
      serverId: "same-host",
      features: { terminalsSurviveRestart: true },
    }),
    getDaemonStatus: vi.fn(async () => ({ pid, version: "2.0.0", serverId: "same-host" })),
    shutdownServer: vi.fn(async () => ({ status: "shutdown_requested" })),
    close: vi.fn(async () => {}),
  }));
  const deps = {
    readDaemonInstance: vi.fn().mockResolvedValueOnce(previous).mockResolvedValue(next),
    prepareLocalDaemonLaunch: vi.fn(() => ({
      command: "/installed/node",
      args: ["/installed/supervisor.js"],
      env: {},
      version: "2.0.0",
    })),
    readPersistedConfig: vi.fn(() => ({})),
    connectToDaemon: vi
      .fn()
      .mockResolvedValueOnce(connections[0])
      .mockResolvedValue(connections[1]),
    stopDaemonInstance: vi.fn(async (_home, options) => {
      await options.requestShutdown();
      return { action: "stopped" };
    }),
    startDaemonInstance: vi.fn(async () => ({ spawned: true, instance: next })),
    retryUnconfirmedTerminalCleanup: vi.fn(async () => {}),
  };
  const run = (options = {}) =>
    createSupervisorReplacement(deps as never)(
      {
        daemonTarget: { kind: "instance", home: "/isolated/home" },
        timeout: "30",
        ...options,
      } as never,
      new Command(),
    );
  return { run, deps, connections, previous, next };
}

describe("restart --replace-supervisor", () => {
  test("a stale endpoint cannot shut down another daemon", async () => {
    const { run, deps, previous, connections } = fixture();
    deps.readDaemonInstance
      .mockReset()
      .mockResolvedValue({ ...previous, serverId: "different-home" });
    await expect(run()).rejects.toMatchObject({ code: "DAEMON_REPLACED" });
    expect(deps.stopDaemonInstance).not.toHaveBeenCalled();
    expect(connections[0]!.shutdownServer).not.toHaveBeenCalled();
    expect(deps.startDaemonInstance).not.toHaveBeenCalled();
  });

  test("preflights and replaces the captured instance, retaining desktop ownership and terminals", async () => {
    const { run, deps, previous, connections } = fixture();
    expect((await run()).data).toMatchObject({
      replacedSupervisor: true,
      previousSupervisorPid: 100,
      supervisorPid: 200,
      previousWorkerPid: 1000,
      workerPid: 2000,
      version: "2.0.0",
    });
    expect(deps.stopDaemonInstance).toHaveBeenCalledWith(
      "/isolated/home",
      expect.objectContaining({ instance: previous, keepTerminals: true }),
    );
    expect(deps.startDaemonInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        home: "/isolated/home",
        desktopManaged: true,
        mode: "managed",
        command: "/installed/node",
      }),
    );
    expect(connections[0]!.shutdownServer).toHaveBeenCalledWith(
      expect.objectContaining({ keepTerminals: true }),
    );
    expect(deps.retryUnconfirmedTerminalCleanup).not.toHaveBeenCalled();
  });

  test("an invoking identity override cannot change the selected daemon's identity", async () => {
    const { run, deps } = fixture();
    deps.prepareLocalDaemonLaunch.mockReturnValue({
      command: "/installed/node",
      args: ["/installed/supervisor.js"],
      env: { PASEO_SERVER_ID: "other-home" } as never,
      version: "2.0.0",
    });
    await run();
    expect(deps.startDaemonInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { PASEO_SERVER_ID: "same-host" },
      }),
    );
  });

  test("rejects endpoint targets and missing local instances before stopping anything", async () => {
    const { run, deps } = fixture();
    await expect(
      run({ daemonTarget: { kind: "endpoint", host: "remote:7777" } }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(deps.readDaemonInstance).not.toHaveBeenCalled();
    deps.readDaemonInstance.mockReset().mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ code: "DAEMON_NOT_RUNNING" });
    expect(deps.stopDaemonInstance).not.toHaveBeenCalled();
  });

  test.each(["prepareLocalDaemonLaunch", "readPersistedConfig"] as const)(
    "%s failure leaves the old instance alone",
    async (name) => {
      const { run, deps } = fixture();
      deps[name].mockImplementation(() => {
        throw new Error("Invalid installation/config");
      });
      await expect(run()).rejects.toThrow("Invalid installation/config");
      expect(deps.stopDaemonInstance).not.toHaveBeenCalled();
      expect(deps.startDaemonInstance).not.toHaveBeenCalled();
    },
  );

  test("refuses terminal preservation on a daemon without the capability", async () => {
    const { run, deps, connections } = fixture();
    connections[0]!.getLastServerInfoMessage = () => ({
      version: "old",
      serverId: "same-host",
      features: {} as never,
    });
    await expect(run()).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
    expect(deps.stopDaemonInstance).not.toHaveBeenCalled();
  });

  test("never claims or kills a competing supervisor", async () => {
    const { run, deps, next } = fixture();
    deps.startDaemonInstance.mockResolvedValue({ spawned: false, instance: next });
    await expect(run()).rejects.toMatchObject({ code: "DAEMON_REPLACED" });
    expect(deps.stopDaemonInstance).toHaveBeenCalledTimes(1);
    expect(deps.connectToDaemon).toHaveBeenCalledTimes(1);
  });

  test.each(["version", "serverId", "pid"] as const)(
    "a wrong replacement %s cannot report success",
    async (field) => {
      const { run, connections } = fixture();
      connections[1]!.getDaemonStatus.mockResolvedValue({
        pid: 2000,
        version: "2.0.0",
        serverId: "same-host",
        [field]: field === "pid" ? 1000 : "wrong",
      });
      await expect(run()).rejects.toMatchObject({ code: "RESTART_NOT_CONFIRMED" });
    },
  );

  test("--kill-terminals confirms cleanup and a stop failure never starts a replacement", async () => {
    const { run, deps, connections } = fixture();
    await run({ killTerminals: true });
    expect(connections[0]!.shutdownServer).toHaveBeenCalledWith(
      expect.objectContaining({ keepTerminals: false }),
    );
    expect(deps.retryUnconfirmedTerminalCleanup).toHaveBeenCalledWith("/isolated/home");
    const failed = fixture();
    failed.deps.stopDaemonInstance.mockRejectedValue(new Error("Stop timed out"));
    await expect(failed.run()).rejects.toThrow("Stop timed out");
    expect(failed.deps.startDaemonInstance).not.toHaveBeenCalled();
  });
});
