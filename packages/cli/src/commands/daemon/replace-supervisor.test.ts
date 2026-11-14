    getDaemonStatus: vi.fn(async () => ({
      pid,
      version: "2.0.0",
      serverId: "same-host",
    })),
  test("a delayed settings handoff cannot replace another worker", async () => {
    const { run, deps, connections } = fixture();
    await expect(run({ expectedWorkerPid: "999" })).rejects.toMatchObject({
      code: "DAEMON_REPLACED",
    });
    expect(deps.stopDaemonInstance).not.toHaveBeenCalled();
    expect(connections[0]!.shutdownServer).not.toHaveBeenCalled();
    expect(deps.startDaemonInstance).not.toHaveBeenCalled();
  });

    expect((await run({ expectedWorkerPid: "1000" })).data).toMatchObject({
    await expect(run()).rejects.toMatchObject({
      code: "TERMINALS_KEEP_UNSUPPORTED",
    });
    deps.startDaemonInstance.mockResolvedValue({
      spawned: false,
      instance: next,
    });
      await expect(run()).rejects.toMatchObject({
        code: "RESTART_NOT_CONFIRMED",
      });
