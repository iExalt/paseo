import { Command } from "commander";
import {
  PaseoConfigRawSchema,
  PaseoConfigRevisionSchema,
} from "@getpaseo/protocol/paseo-config-schema";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

interface ProjectConfigOptions extends CommandOptions {
  project?: string;
  path?: string;
  revision?: string;
}

export async function runProjectConfig(
  action: "get" | "set",
  raw: string | undefined,
  options: ProjectConfigOptions,
) {
  if (Boolean(options.project) === Boolean(options.path))
    throw new Error("Choose exactly one --project <id> or --path <daemon-root>");
  if (action === "get" && options.revision !== undefined)
    throw new Error("--revision is only valid for set");
  const config = action === "set" ? PaseoConfigRawSchema.parse(JSON.parse(raw!)) : undefined;
  const revision =
    options.revision === undefined
      ? undefined
      : PaseoConfigRevisionSchema.nullable().parse(JSON.parse(options.revision));
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    let repoRoot = options.path;
    if (options.project) {
      const { projects } = await client.listProjects();
      const project = projects.find((entry) => entry.projectId === options.project);
      if (!project)
        throw { code: "PROJECT_NOT_FOUND", message: `Unknown project: ${options.project}` };
      repoRoot = project.projectRootPath;
    }
    const current = await client.readProjectConfig(repoRoot!);
    if (!current.ok)
      throw {
        ...current.error,
        message: `Project configuration: ${current.error.code}`,
        details: JSON.stringify(current.error),
      };
    const data =
      action === "get"
        ? current
        : await client.writeProjectConfig({
            repoRoot: current.repoRoot,
            config: config!,
            expectedRevision: revision === undefined ? current.revision : revision,
          });
    if (!data.ok)
      throw {
        ...data.error,
        message: `Project configuration: ${data.error.code}`,
        details: JSON.stringify(data.error),
      };
    return {
      type: "single" as const,
      data,
      schema: {
        idField: () => data.repoRoot,
        columns: [],
        renderHuman: () => JSON.stringify(data, null, 2),
      },
    };
  } finally {
    await client.close();
  }
}

export function projectConfigCommand(): Command {
  const config = new Command("config").description("Read or replace a project's paseo.json");
  for (const action of ["get", "set"] as const) {
    const command = addJsonAndDaemonHostOptions(
      config.command(action === "set" ? "set <config-json>" : "get"),
    )
      .option("--project <id>", "Registered project ID")
      .option("--path <daemon-root>", "Registered daemon-side project root");
    if (action === "set")
      command.option(
        "--revision <json>",
        "Expected revision from get (null for a missing file); default: fresh read for intentional replacement",
      );
    if (action === "set")
      command.action(
        withOutput((raw: string, options: ProjectConfigOptions, _command: Command) =>
          runProjectConfig(action, raw, options),
        ),
      );
    else
      command.action(
        withOutput((options: ProjectConfigOptions, _command: Command) =>
          runProjectConfig(action, undefined, options),
        ),
      );
  }
  return config;
}
