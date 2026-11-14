    const client = await deps.connectToDaemon({
      target,
      instance: previous,
      timeout: remaining(),
    });
      if (
        options.expectedWorkerPid !== undefined &&
        String(before.pid) !== String(options.expectedWorkerPid)
      ) {
        throw new DaemonInstanceError(
          "DAEMON_REPLACED",
          "The worker requesting this restart was replaced; refusing to stop another worker.",
        );
      }
      const status = await replacement.getDaemonStatus({
        timeout: remaining(),
      });
