import { Command } from "commander";
import { requireTerminalKeepCapability } from "@getpaseo/client/internal/daemon-client";
import {
  DaemonInstanceError,
  isSameDaemonInstance,
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
  retryUnconfirmedTerminalCleanup,
} from "@getpaseo/server/daemon-control";
import { readPersistedConfig } from "@getpaseo/server/configuration";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import { parseTimeoutMs, prepareLocalDaemonLaunch } from "./local-daemon.js";

const runtime = {
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
  retryUnconfirmedTerminalCleanup,
  readPersistedConfig,
  connectToDaemon,
  prepareLocalDaemonLaunch,
};

export function createSupervisorReplacement(deps: typeof runtime = runtime) {
  return async (options: CommandOptions, _command: Command) => {
    const target = options.daemonTarget;
    if (target.kind !== "instance")
      throw new DaemonInstanceError(
        "INVALID_OPTIONS",
        "--replace-supervisor requires a local --home, not a remote endpoint.",
      );
    const deadline = Date.now() + parseTimeoutMs(options.timeout);
    const remaining = () => {
      if (Date.now() >= deadline)
        throw new DaemonInstanceError(
          "RESTART_NOT_CONFIRMED",
          "Supervisor replacement deadline expired.",
        );
      return deadline - Date.now();
    };
    const previous = await deps.readDaemonInstance(target.home);
    if (!previous)
      throw new DaemonInstanceError(
        "DAEMON_NOT_RUNNING",
        `Daemon is not running for ${target.home}.`,
      );
    const launch = deps.prepareLocalDaemonLaunch();
    deps.readPersistedConfig(target.home);
    const client = await deps.connectToDaemon({ target, instance: previous, timeout: remaining() });
    const keepTerminals = options.killTerminals !== true;
    let previousWorkerPid: number;
    let serverId: string;
    try {
      if (keepTerminals) requireTerminalKeepCapability(client, target.home);
      const before = await client.getDaemonStatus({ timeout: remaining() });
      if (
        !previous.serverId ||
        before.serverId !== previous.serverId ||
        client.getLastServerInfoMessage()?.serverId !== previous.serverId
      ) {
        throw new DaemonInstanceError(
          "DAEMON_REPLACED",
          "Connected peer does not match the captured local daemon; refusing to stop it.",
        );
      }
      previousWorkerPid = before.pid;
      serverId = before.serverId;
      await deps.stopDaemonInstance(target.home, {
        instance: previous,
        keepTerminals,
        timeoutMs: remaining(),
        requestShutdown: async () => {
          await client.shutdownServer({ keepTerminals, timeout: remaining() });
        },
      });
    } finally {
      await client.close();
    }
    const started = await deps.startDaemonInstance({
      home: target.home,
      command: launch.command,
      args: launch.args,
      env: { ...launch.env, PASEO_SERVER_ID: serverId },
      desktopManaged: previous.desktopManaged,
      mode: "managed",
      timeoutMs: remaining(),
    });
    if (!started.spawned || isSameDaemonInstance(previous, started.instance)) {
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        "Another supervisor acquired this home; refusing to claim or stop it.",
      );
    }
    const replacement = await deps.connectToDaemon({
      target,
      instance: started.instance,
      timeout: remaining(),
    });
    let workerPid: number;
    try {
      const status = await replacement.getDaemonStatus({ timeout: remaining() });
      const current = await deps.readDaemonInstance(target.home);
      if (
        !current ||
        !isSameDaemonInstance(current, started.instance) ||
        status.serverId !== serverId ||
        status.version !== launch.version ||
        status.pid === previousWorkerPid
      ) {
        throw new DaemonInstanceError(
          "RESTART_NOT_CONFIRMED",
          "Replacement identity or installed version did not match; inspect daemon status and logs.",
        );
      }
      if (!keepTerminals) await deps.retryUnconfirmedTerminalCleanup(target.home);
      workerPid = status.pid;
    } finally {
      await replacement.close();
    }
    return {
      type: "single" as const,
      data: {
        action: "restarted",
        home: target.home,
        replacedSupervisor: true,
        previousSupervisorPid: previous.pid,
        supervisorPid: started.instance.pid,
        previousWorkerPid,
        workerPid,
        version: launch.version,
      },
      schema: {
        idField: "action" as const,
        columns: [],
        renderHuman: () =>
          `Replaced supervisor ${previous.pid} → ${started.instance.pid} with installed daemon ${launch.version} at ${target.home}.`,
      },
    };
  };
}

export const replaceSupervisor = createSupervisorReplacement();
