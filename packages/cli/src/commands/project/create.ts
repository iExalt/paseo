import path from "node:path";
import type { Command } from "commander";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import { projectSchema, toProjectRow, type ProjectRow } from "./shared.js";

export function resolveProjectPath(input: {
  pathArg?: string;
  cwd: string;
  daemonTarget?: string;
}): string {
  if (input.daemonTarget) {
    if (input.pathArg === undefined) {
      throw {
        code: "MISSING_PATH",
        message: "Project path is required when targeting a daemon explicitly",
        details: "Usage: paseo project create <path> --host <host>",
      } satisfies CommandError;
    }
    return input.pathArg;
  }

  return path.resolve(input.cwd, input.pathArg ?? ".");
}

export async function runCreateCommand(
  pathArg: string | undefined,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ProjectRow>> {
  validateDirectoryOptions(pathArg, options);
  const projectPath = options.mkdir
    ? pathArg!
    : resolveProjectPath({
        pathArg,
        cwd: process.cwd(),
        daemonTarget:
          options.daemonTarget.kind === "endpoint" ? options.daemonTarget.host : undefined,
      });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });

  try {
    if (
      options.mkdir &&
      client.getLastServerInfoMessage()?.features?.projectCreateDirectory !== true
    )
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "Update the host to create project directories",
      };
    const payload = options.mkdir
      ? await client.createProjectDirectory({
          parentPath: options.parent as string,
          name: projectPath,
        })
      : await client.addProject(projectPath);
    if (!payload.project) {
      throw {
        code:
          "errorCode" in payload
            ? (payload.errorCode ?? "PROJECT_CREATE_FAILED")
            : "PROJECT_CREATE_FAILED",
        message: payload.error ?? "Project creation failed",
        details: JSON.stringify(payload),
      };
    }
    return { type: "single", data: toProjectRow(payload.project), schema: projectSchema };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_CREATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function validateDirectoryOptions(pathArg: string | undefined, options: CommandOptions): void {
  if (options.parent !== undefined && !options.mkdir) throw new Error("--parent requires --mkdir");
  if (
    options.mkdir &&
    (!pathArg?.trim() ||
      /[\\/]/.test(pathArg) ||
      [".", ".."].includes(pathArg) ||
      typeof options.parent !== "string" ||
      !options.parent.trim())
  )
    throw new Error("Use project create <name> --mkdir --parent <daemon-path>");
}
