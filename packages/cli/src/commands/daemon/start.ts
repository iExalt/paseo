import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { Command } from "commander";
import { daemonLogPath, droppedManagedEnvOverrides } from "@getpaseo/server/daemon-control";
import { launchLocalDaemon, parseTimeoutMs, rejectRemovedLaunchFlags } from "./local-daemon.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

export function startCommand(): Command {
  return rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("start")))
    .description("Start the local daemon from persistent configuration (local operation)")
    .option("--timeout <seconds>", "Readiness deadline (default: 600)")
    .action(withOutput(runStart));
}

export async function runStart(options: CommandOptions, _command: Command) {
  if (options.daemonTarget.kind !== "instance") throw new Error("Start requires a local home");
  const home = options.daemonTarget.home;
  const dropped = droppedManagedEnvOverrides(process.env);
  if (dropped.length > 0) {
    process.stderr.write(
      `Ignoring ${dropped.join(", ")}: daemon start reads ${home}/config.json. Use paseo daemon run to apply environment overrides.\n`,
    );
  }
  const result = await launchLocalDaemon({ home, timeoutMs: parseTimeoutMs(options.timeout) });
  const data = {
    action: result.spawned ? "started" : "already_running",
    home,
    pid: result.instance.pid,
    listen: result.instance.listen,
    logPath: daemonLogPath(home),
  };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: "pid" as const,
      columns: [],
      renderHuman: () =>
        `${result.spawned ? "Started" : "Already running"}: PID ${data.pid}${data.listen ? `, listening on ${data.listen}` : ", not ready"}\nLogs: ${data.logPath}`,
    },
  };
}

export function daemonRunCommand(): Command {
  return rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("run")))
    .description("Run a local daemon in the foreground with deployment environment overrides")
    .addHelpText(
      "after",
      "\nForeground output streams text logs; --json and --format json/yaml are not supported. Use daemon start or daemon status with --json for machine-readable results.",
    )
    .option("--no-agent-tools", "Disable native Paseo tools for agents")
    .action(
      withOutput(async (options: CommandOptions & { agentTools?: boolean }, _command: Command) => {
        const format = options.json ? "json" : options.format?.trim().toLowerCase();
        if (format === "json" || format === "yaml") {
          throw {
            code: "INVALID_FORMAT",
            message:
              "daemon run streams text logs and does not support JSON or YAML output. Use daemon start or daemon status with --json for machine-readable results.",
          };
        }
        if (options.daemonTarget.kind !== "instance") throw new Error("Run requires a local home");
        const result = await launchLocalDaemon({
          home: options.daemonTarget.home,
          foreground: true,
          ...(options.agentTools === false ? { agentToolsEnabled: false } : {}),
        });
        process.exitCode = result.exitCode ?? 0;
        return {
          type: "single" as const,
          data: { pid: result.instance.pid, action: result.spawned ? "exited" : "already_running" },
          schema: { idField: "pid" as const, columns: [] },
        };
      }),
    );
}
