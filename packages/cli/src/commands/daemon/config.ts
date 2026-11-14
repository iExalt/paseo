import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { Command } from "commander";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import {
  readPersistedConfig,
  getPersistedConfigValue,
  editPersistedConfig,
} from "@getpaseo/server/configuration";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(key)
        ? "[redacted]"
        : redact(item),
    ]),
  );
}

export function configResult(data: Record<string, unknown>) {
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "configuration",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}

function homeOf(options: CommandOptions) {
  if (options.daemonTarget.kind !== "instance")
    throw new Error("Configuration edits require --home");
  return options.daemonTarget.home;
}

async function applySaved(home: string, options: CommandOptions) {
  const nextCommand = `paseo daemon start --home ${JSON.stringify(home)}`;
  const instance = await readDaemonInstance(home);
  if (!instance?.listen)
    return configResult({
      action: "saved",
      applied: false,
      message: "Saved; not applied to a running daemon",
      nextCommand,
    });
  let client;
  try {
    client = await connectToDaemon({ target: options.daemonTarget, timeout: 1_500 });
  } catch {
    return configResult({
      action: "saved",
      applied: false,
      message: "Saved; not applied to a running daemon",
      nextCommand: `paseo daemon reload --home ${JSON.stringify(home)}`,
    });
  }
  try {
    const reload = await client.reloadDaemonConfig();
    return configResult({ action: "saved", ...reload });
  } catch (error) {
    throw { code: "CONFIG_SAVED_RELOAD_FAILED", message: `Saved; reload failed: ${String(error)}` };
  } finally {
    await client.close();
  }
}

export function daemonConfigCommand(): Command {
  const config = new Command("config").description(
    "Read or edit configuration (--home: local persisted paths; --host: remote effective paths)",
  );
  addJsonAndDaemonHostOptions(config.command("get [path]")).action(
    withOutput(async (field: string | undefined, options: CommandOptions, _command: Command) => {
      if (options.daemonTarget.kind !== "instance") {
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          const { config: effective } = await client.getDaemonConfig();
          const value = field
            ? field
                .split(".")
                .reduce<unknown>(
                  (object, key) =>
                    object && typeof object === "object" && Object.hasOwn(object, key)
                      ? (object as Record<string, unknown>)[key]
                      : undefined,
                  effective,
                )
            : effective;
          return configResult({
            source: "effective",
            path: field ?? null,
            set: value !== undefined,
            value:
              field &&
              /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(field)
                ? "[redacted]"
                : redact(value),
          });
        } finally {
          await client.close();
        }
      }
      const persisted = readPersistedConfig(homeOf(options));
      const value = field ? getPersistedConfigValue(persisted, field) : persisted;
      return configResult({
        source: "configured",
        path: field ?? null,
        set: value !== undefined,
        value:
          field && /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(field)
            ? "[redacted]"
            : redact(value),
      });
    }),
  );
  addJsonAndDaemonHostOptions(config.command("set <path> <value>"))
    .option("--string", "Interpret value literally as a string")
    .action(
      withOutput(async (field: string, raw: string, options: CommandOptions, _command: Command) => {
        let value: unknown = raw;
        if (!options.string) {
          try {
            value = JSON.parse(raw);
          } catch {
            /* Unquoted input is a string. */
          }
        }
        if (options.daemonTarget.kind !== "instance")
          return remoteConfigEdit(field, { value }, options);
        editPersistedConfig(homeOf(options), field, { value });
        return applySaved(homeOf(options), options);
      }),
    );
  addJsonAndDaemonHostOptions(config.command("unset <path>")).action(
    withOutput(async (field: string, options: CommandOptions, _command: Command) => {
      if (options.daemonTarget.kind !== "instance")
        return remoteConfigEdit(field, { unset: true }, options);
      editPersistedConfig(homeOf(options), field, { unset: true });
      return applySaved(homeOf(options), options);
    }),
  );
  return config;
}

export async function remoteConfigEdit(
  path: string,
  edit: { value?: unknown; unset?: boolean },
  options: CommandOptions,
) {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(daemonConfigEdit): added in v0.27.0, remove gate after 2027-05-14 once daemon floor supports edits.
    if (client.getLastServerInfoMessage()?.features?.daemonConfigEdit !== true)
      throw new Error("Update the host to edit remote configuration");
    const { config } = await client.editDaemonConfig(path, edit);
    const value = path
      .split(".")
      .reduce<unknown>(
        (object, key) =>
          object && typeof object === "object" && Object.hasOwn(object, key)
            ? (object as Record<string, unknown>)[key]
            : undefined,
        config,
      );
    return configResult({
      action: edit.unset ? "unset" : "set",
      path,
      saved: true,
      source: "effective",
      value: /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(path)
        ? "[redacted]"
        : redact(value),
    });
  } finally {
    await client.close();
  }
}
